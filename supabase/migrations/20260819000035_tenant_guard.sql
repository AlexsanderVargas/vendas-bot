-- =============================================================================
-- Correção de segurança: guarda de tenant nas funções SECURITY DEFINER.
--
-- Problema: várias funções SECURITY DEFINER recebem o tenant (ou um recurso do
-- qual o tenant é derivado) como PARÂMETRO e têm `grant execute ... to
-- authenticated`, mas NÃO verificavam se o chamador pertence àquele tenant.
-- Como o front consome o PostgREST diretamente com a anon key + o JWT do
-- usuário, QUALQUER usuário autenticado — inclusive um cliente B2C sem vínculo
-- com loja nenhuma — podia chamar `POST /rest/v1/rpc/<func>` com o tenant de um
-- concorrente e ler (ou, no caso do estoque, escrever) dados alheios. O
-- `requirePermission` da API não protegia porque o RPC é alcançável fora dela.
--
-- Correção: um único predicado `can_access_tenant(p_tenant_id)` — verdadeiro
-- para o `service_role` (worker e triggers de ingestão de marketplace, que
-- rodam sem tenant no contexto) OU para funcionário ativo do tenant. As funções
-- de LEITURA passam a filtrar por ele (não-autorizado recebe conjunto vazio ou
-- exceção 42501); as de ESCRITA de estoque retornam o erro `nao_autorizado` já
-- previsto no contrato. Nenhum contrato de entrada/saída muda para o chamador
-- legítimo. `tenant_nps` fica de fora de propósito: é reputação pública
-- (`/public/reputation`), acessível a anônimos por design.
--
-- Chamadas legítimas continuam funcionando porque a API sempre passa o tenant
-- do próprio funcionário (`request.requireTenantId()`), e o worker/os triggers
-- rodam como `service_role`.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- can_access_tenant(p_tenant_id uuid) -> boolean
-- Contrato NOVO. service_role (chave administrativa, só o backend a possui) ou
-- funcionário ativo do tenant. STABLE porque depende só do JWT da requisição.
-- -----------------------------------------------------------------------------
create or replace function public.can_access_tenant(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'role', '') = 'service_role'
      or public.is_staff_of(p_tenant_id);
$$;

revoke execute on function public.can_access_tenant(uuid) from public;
grant execute on function public.can_access_tenant(uuid) to authenticated, service_role;

-- =============================================================================
-- Relatórios financeiros (20260818000027_reports.sql)
-- =============================================================================

-- dre_report: contrato de saída inalterado (jsonb). Guarda por exceção.
create or replace function public.dre_report(
  p_tenant_id uuid,
  p_from      date default (current_date - 30),
  p_to        date default current_date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_revenue      numeric(14,2);
  v_delivery     numeric(14,2);
  v_discounts    numeric(14,2);
  v_orders       integer;
  v_cmv          numeric(14,2);
  v_fixed        numeric(14,2);
  v_variable     numeric(14,2);
  v_gross        numeric(14,2);
  v_net          numeric(14,2);
begin
  if not public.can_access_tenant(p_tenant_id) then
    raise exception 'nao_autorizado' using errcode = '42501';
  end if;

  -- Receita: pedidos efetivamente concluídos no período.
  select coalesce(sum(o.subtotal), 0), coalesce(sum(o.delivery_fee), 0),
         coalesce(sum(o.discount), 0), count(*)
    into v_revenue, v_delivery, v_discounts, v_orders
  from public.orders o
  where o.tenant_id = p_tenant_id
    and o.status in ('delivered', 'completed')
    and o.created_at::date between p_from and p_to;

  -- CMV realizado: custo dos lotes que saíram por causa desses pedidos.
  select coalesce(sum(m.quantity * m.unit_cost), 0) into v_cmv
  from public.stock_movements m
  join public.orders o on o.id = m.order_id
  where m.tenant_id = p_tenant_id
    and m.type = 'out'
    and o.status in ('delivered', 'completed')
    and o.created_at::date between p_from and p_to;

  -- Despesas do período por natureza.
  select coalesce(sum(a.amount) filter (where coalesce(c.is_fixed, true)), 0),
         coalesce(sum(a.amount) filter (where c.is_fixed = false), 0)
    into v_fixed, v_variable
  from public.financial_accounts a
  left join public.expense_categories c on c.id = a.category_id
  where a.tenant_id = p_tenant_id
    and a.direction = 'payable'
    and a.status <> 'canceled'
    and a.due_date between p_from and p_to;

  v_gross := round(v_revenue - v_cmv, 2);
  v_net := round(v_gross - v_fixed - v_variable, 2);

  return jsonb_build_object(
    'revenue', v_revenue,
    'deliveryRevenue', v_delivery,
    'discounts', v_discounts,
    'cmv', round(v_cmv, 2),
    'grossProfit', v_gross,
    'grossMarginPercent', case when v_revenue = 0 then 0
                               else round(v_gross * 100 / v_revenue, 2) end,
    'fixedExpenses', v_fixed,
    'variableExpenses', v_variable,
    'netProfit', v_net,
    'netMarginPercent', case when v_revenue = 0 then 0
                             else round(v_net * 100 / v_revenue, 2) end,
    'orderCount', v_orders,
    'averageTicket', case when v_orders = 0 then 0
                          else round((v_revenue + v_delivery) / v_orders, 2) end);
end;
$$;

-- cash_flow_report: contrato de saída inalterado (setof). Guarda por predicado.
create or replace function public.cash_flow_report(
  p_tenant_id uuid,
  p_from      date default (current_date - 30),
  p_to        date default current_date
)
returns table (
  day             date,
  inflow          numeric,
  outflow         numeric,
  net             numeric,
  running_balance numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  with dias as (
    select generate_series(p_from, p_to, interval '1 day')::date as day
  ), movimentos as (
    select m.created_at::date as day,
           sum(m.amount) filter (where m.type in ('sale', 'supply', 'opening')) as inflow,
           sum(m.amount) filter (where m.type in ('withdrawal', 'refund')) as outflow
    from public.cash_movements m
    where m.tenant_id = p_tenant_id
      and public.can_access_tenant(p_tenant_id)
      and m.created_at::date between p_from and p_to
    group by 1
  ), diario as (
    select d.day,
           coalesce(m.inflow, 0) as inflow,
           coalesce(m.outflow, 0) as outflow,
           coalesce(m.inflow, 0) - coalesce(m.outflow, 0) as net
    from dias d
    left join movimentos m on m.day = d.day
  )
  select day, inflow, outflow, net,
         sum(net) over (order by day rows between unbounded preceding and current row)
  from diario
  order by day;
$$;

-- profit_projection: contrato de saída inalterado (jsonb). Guarda por exceção.
create or replace function public.profit_projection(
  p_tenant_id      uuid,
  p_lookback_days  integer default 30,
  p_horizon_days   integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dre        jsonb;
  v_days       integer := greatest(p_lookback_days, 1);
  v_revenue    numeric(14,2);
  v_net        numeric(14,2);
  v_orders     integer;
  v_daily_rev  numeric(14,2);
  v_daily_net  numeric(14,2);
begin
  if not public.can_access_tenant(p_tenant_id) then
    raise exception 'nao_autorizado' using errcode = '42501';
  end if;

  v_dre := public.dre_report(p_tenant_id, current_date - v_days, current_date);

  v_revenue := (v_dre->>'revenue')::numeric;
  v_net := (v_dre->>'netProfit')::numeric;
  v_orders := (v_dre->>'orderCount')::integer;

  v_daily_rev := round(v_revenue / v_days, 2);
  v_daily_net := round(v_net / v_days, 2);

  return jsonb_build_object(
    'basisDays', v_days,
    'dailyRevenue', v_daily_rev,
    'dailyNetProfit', v_daily_net,
    'horizonDays', p_horizon_days,
    'projectedRevenue', round(v_daily_rev * p_horizon_days, 2),
    'projectedNetProfit', round(v_daily_net * p_horizon_days, 2),
    'confidence', case when v_days < 7 or v_orders = 0 then 'low'
                       when v_orders < 30 then 'medium'
                       else 'high' end);
end;
$$;

-- top_products_report: contrato de saída inalterado (setof). Guarda por predicado.
create or replace function public.top_products_report(
  p_tenant_id uuid,
  p_from      date default (current_date - 30),
  p_to        date default current_date,
  p_limit     integer default 10
)
returns table (
  product_id   uuid,
  product_name text,
  quantity     numeric,
  revenue      numeric,
  order_count  integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select oi.product_id, oi.product_name,
         sum(oi.quantity), sum(oi.total), count(distinct oi.order_id)::integer
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  where oi.tenant_id = p_tenant_id
    and public.can_access_tenant(p_tenant_id)
    and o.status in ('delivered', 'completed')
    and o.created_at::date between p_from and p_to
  group by oi.product_id, oi.product_name
  order by sum(oi.total) desc
  limit greatest(p_limit, 0);
$$;

-- =============================================================================
-- Alertas de estoque (20260818000018_auto_deduction.sql)
-- =============================================================================

-- stock_alerts: contrato de saída inalterado (setof). Guarda nos dois ramos.
create or replace function public.stock_alerts(
  p_tenant_id      uuid,
  p_expiring_days  integer default 7
)
returns table (
  kind            text,
  ingredient_id   uuid,
  ingredient_name text,
  base_unit       public.unit_of_measure,
  quantity        numeric,
  threshold       numeric,
  expires_at      date,
  batch_code      text
)
language sql
stable
security definer
set search_path = ''
as $$
  select 'below_minimum'::text, i.id, i.name, i.base_unit,
         i.stock_quantity, i.minimum_stock, null::date, null::text
  from public.ingredients i
  where i.tenant_id = p_tenant_id and i.is_active
    and public.can_access_tenant(p_tenant_id)
    and i.stock_quantity <= i.minimum_stock

  union all

  select case when b.expires_at < current_date then 'expired' else 'expiring' end,
         i.id, i.name, i.base_unit,
         b.quantity_remaining, null::numeric, b.expires_at, b.batch_code
  from public.stock_batches b
  join public.ingredients i on i.id = b.ingredient_id
  where b.tenant_id = p_tenant_id
    and public.can_access_tenant(p_tenant_id)
    and b.quantity_remaining > 0
    and b.expires_at is not null
    and b.expires_at <= current_date + p_expiring_days

  order by 1, 3;
$$;

-- =============================================================================
-- Estoque: escrita (20260818000017_stock_batches.sql, 20260818000018)
-- Estas rodam TAMBÉM como service_role (worker + trigger de baixa dos pedidos
-- de marketplace), por isso can_access_tenant permite service_role. Retornam o
-- erro `nao_autorizado` já previsto no contrato jsonb.
-- =============================================================================

create or replace function public.consume_stock(
  p_ingredient_id uuid,
  p_quantity      numeric,
  p_type          public.stock_movement_type default 'out',
  p_reason        text default null,
  p_order_id      uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ingredient public.ingredients%rowtype;
  v_batch      record;
  v_remaining  numeric(14,3) := p_quantity;
  v_take       numeric(14,3);
  v_consumed   numeric(14,3) := 0;
  v_batches    jsonb := '[]'::jsonb;
begin
  if p_quantity is null or p_quantity <= 0 then
    return jsonb_build_object('ok', false, 'error', 'quantidade_invalida',
      'consumed', 0, 'stockQuantity', 0, 'batches', v_batches);
  end if;

  select * into v_ingredient from public.ingredients where id = p_ingredient_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'insumo_nao_encontrado',
      'consumed', 0, 'stockQuantity', 0, 'batches', v_batches);
  end if;

  if not public.can_access_tenant(v_ingredient.tenant_id) then
    return jsonb_build_object('ok', false, 'error', 'nao_autorizado',
      'consumed', 0, 'stockQuantity', 0, 'batches', v_batches);
  end if;

  -- FEFO com FIFO como desempate. FOR UPDATE serializa baixas concorrentes
  -- sobre o mesmo lote.
  for v_batch in
    select id, quantity_remaining, unit_cost
    from public.stock_batches
    where ingredient_id = p_ingredient_id and quantity_remaining > 0
    order by expires_at nulls last, received_at
    for update
  loop
    exit when v_remaining <= 0;

    v_take := least(v_batch.quantity_remaining, v_remaining);

    update public.stock_batches
    set quantity_remaining = quantity_remaining - v_take
    where id = v_batch.id;

    insert into public.stock_movements (tenant_id, ingredient_id, batch_id, order_id,
                                        type, quantity, unit_cost, reason, created_by)
    values (v_ingredient.tenant_id, p_ingredient_id, v_batch.id, p_order_id,
            p_type, v_take, v_batch.unit_cost, p_reason, auth.uid());

    v_batches := v_batches || jsonb_build_array(
      jsonb_build_object('batchId', v_batch.id, 'quantity', v_take));
    v_consumed := v_consumed + v_take;
    v_remaining := v_remaining - v_take;
  end loop;

  if v_consumed > 0 then
    update public.ingredients
    set stock_quantity = stock_quantity - v_consumed
    where id = p_ingredient_id;
  end if;

  return jsonb_build_object(
    'ok', v_remaining <= 0,
    'error', case when v_remaining > 0 then 'estoque_insuficiente' else null end,
    'consumed', v_consumed,
    'stockQuantity', v_ingredient.stock_quantity - v_consumed,
    'batches', v_batches);
end;
$$;

create or replace function public.deduct_order_stock(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order     public.orders%rowtype;
  v_line      record;
  v_result    jsonb;
  v_needed    numeric(14,4);
  v_count     integer := 0;
  v_shortages jsonb := '[]'::jsonb;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'pedido_nao_encontrado',
      'deducted', 0, 'shortages', v_shortages);
  end if;

  if not public.can_access_tenant(v_order.tenant_id) then
    return jsonb_build_object('ok', false, 'error', 'nao_autorizado',
      'deducted', 0, 'shortages', v_shortages);
  end if;

  if v_order.stock_deducted_at is not null then
    return jsonb_build_object('ok', true, 'error', 'ja_baixado',
      'deducted', 0, 'shortages', v_shortages);
  end if;

  -- Agrega por insumo: o mesmo insumo pode aparecer em vários itens do pedido.
  for v_line in
    select r.ingredient_id,
           i.name as ingredient_name,
           sum(public.recipe_effective_quantity(r.quantity, r.waste_percent) * oi.quantity) as needed
    from public.order_items oi
    join public.product_recipes r on r.product_id = oi.product_id
    join public.ingredients i on i.id = r.ingredient_id
    where oi.order_id = p_order_id
    group by r.ingredient_id, i.name
  loop
    v_needed := round(v_line.needed, 4);
    v_result := public.consume_stock(
      v_line.ingredient_id, v_needed, 'out',
      'Baixa automática do pedido nº ' || v_order.order_number, p_order_id);

    v_count := v_count + 1;

    if (v_result->>'error') = 'estoque_insuficiente' then
      v_shortages := v_shortages || jsonb_build_array(jsonb_build_object(
        'ingredientId', v_line.ingredient_id,
        'ingredientName', v_line.ingredient_name,
        'requested', v_needed,
        'consumed', (v_result->>'consumed')::numeric));
    end if;
  end loop;

  update public.orders set stock_deducted_at = now() where id = p_order_id;

  return jsonb_build_object('ok', true, 'error', null,
    'deducted', v_count, 'shortages', v_shortages);
end;
$$;

-- =============================================================================
-- KDS (20260818000022_kds.sql, 20260818000031_kds_queue_v2.sql)
-- =============================================================================

-- kds_queue_v2: contrato de saída inalterado (setof). Guarda por predicado.
create or replace function public.kds_queue_v2(p_tenant_id uuid)
returns table (
  order_id            uuid,
  order_number        bigint,
  origin              text,
  external_display_id text,
  channel             text,
  table_label         text,
  item_id             uuid,
  product_name        text,
  quantity            numeric,
  notes               text,
  selected_options    jsonb,
  prep_status         text,
  waiting_seconds     integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.order_number, o.origin::text, o.external_display_id,
         o.channel::text, t.label,
         oi.id, oi.product_name, oi.quantity, oi.notes, oi.selected_options,
         oi.prep_status::text,
         greatest(0, extract(epoch from (now() - oi.created_at))::integer)
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  left join public.dining_tables t on t.id = o.table_id
  where oi.tenant_id = p_tenant_id
    and public.can_access_tenant(p_tenant_id)
    and oi.requires_prep
    and oi.prep_status in ('pending', 'preparing')
    and o.status in ('placed', 'confirmed', 'preparing', 'ready')
  order by oi.created_at;
$$;

-- marketplace_orders_report: contrato de saída inalterado (setof).
create or replace function public.marketplace_orders_report(
  p_tenant_id uuid,
  p_from      date default (current_date - 30),
  p_to        date default current_date
)
returns table (
  origin         text,
  order_count    integer,
  revenue        numeric,
  average_ticket numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.origin::text, count(*)::integer, coalesce(sum(o.total), 0),
         case when count(*) = 0 then 0 else round(coalesce(sum(o.total), 0) / count(*), 2) end
  from public.orders o
  where o.tenant_id = p_tenant_id
    and public.can_access_tenant(p_tenant_id)
    and o.status in ('delivered', 'completed')
    and o.created_at::date between p_from and p_to
  group by o.origin
  order by 3 desc;
$$;

-- kds_queue (v1, mantida por compatibilidade): contrato de saída inalterado.
create or replace function public.kds_queue(p_tenant_id uuid)
returns table (
  order_id        uuid,
  order_number    bigint,
  channel         text,
  table_label     text,
  item_id         uuid,
  product_name    text,
  quantity        numeric,
  notes           text,
  selected_options jsonb,
  prep_status     text,
  waiting_seconds integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.order_number, o.channel::text, t.label,
         oi.id, oi.product_name, oi.quantity, oi.notes, oi.selected_options,
         oi.prep_status::text,
         greatest(0, extract(epoch from (now() - oi.created_at))::integer)
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  left join public.dining_tables t on t.id = o.table_id
  where oi.tenant_id = p_tenant_id
    and public.can_access_tenant(p_tenant_id)
    and oi.requires_prep
    and oi.prep_status in ('pending', 'preparing')
    and o.status in ('placed', 'confirmed', 'preparing', 'ready')
  order by oi.created_at;
$$;

-- =============================================================================
-- Mídias (20260818000033_media.sql)
-- =============================================================================

-- unused_media: contrato de saída inalterado (setof). Guarda por predicado.
create or replace function public.unused_media(p_tenant_id uuid)
returns table (
  id           uuid,
  storage_path text,
  public_url   text,
  kind         public.media_kind,
  size_bytes   bigint,
  created_at   timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select m.id, m.storage_path, m.public_url, m.kind, m.size_bytes, m.created_at
  from public.tenant_media m
  where m.tenant_id = p_tenant_id
    and public.can_access_tenant(p_tenant_id)
    and not exists (select 1 from public.product_media pm where pm.media_id = m.id)
    and not exists (select 1 from public.products p
                    where p.tenant_id = m.tenant_id and p.image_url = m.public_url)
    and not exists (select 1 from public.categories c
                    where c.tenant_id = m.tenant_id and c.image_url = m.public_url)
    and not exists (
      select 1 from public.tenant_branding b
      where b.tenant_id = m.tenant_id
        and m.public_url in (b.logo_url, b.logo_dark_url, b.favicon_url,
                             b.cover_url, b.social_image_url))
  order by m.created_at desc;
$$;

-- =============================================================================
-- Caixa (20260818000023_cash_register.sql)
-- =============================================================================

-- cash_session_summary: contrato de saída inalterado (jsonb). O tenant vem da
-- sessão; guarda por exceção após carregá-la.
create or replace function public.cash_session_summary(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_session public.cash_sessions%rowtype;
  v_result  jsonb;
begin
  select * into v_session from public.cash_sessions where id = p_session_id;
  if not found then
    return jsonb_build_object('openingAmount', 0, 'sales', 0, 'supplies', 0,
      'withdrawals', 0, 'refunds', 0, 'expectedCash', 0,
      'byMethod', '{}'::jsonb, 'movementCount', 0);
  end if;

  if not public.can_access_tenant(v_session.tenant_id) then
    raise exception 'nao_autorizado' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'openingAmount', v_session.opening_amount,
    'sales', coalesce(sum(amount) filter (where type = 'sale'), 0),
    'supplies', coalesce(sum(amount) filter (where type = 'supply'), 0),
    'withdrawals', coalesce(sum(amount) filter (where type = 'withdrawal'), 0),
    'refunds', coalesce(sum(amount) filter (where type = 'refund'), 0),
    'expectedCash', v_session.opening_amount
      + coalesce(sum(amount) filter (where type in ('sale', 'supply') and method = 'cash'), 0)
      - coalesce(sum(amount) filter (where type in ('withdrawal', 'refund') and method = 'cash'), 0),
    'byMethod', coalesce(
      (select jsonb_object_agg(method, total) from (
         select method::text, sum(amount) as total
         from public.cash_movements
         where session_id = p_session_id and type = 'sale'
         group by method) as m), '{}'::jsonb),
    'movementCount', count(*)
  ) into v_result
  from public.cash_movements
  where session_id = p_session_id;

  return v_result;
end;
$$;
