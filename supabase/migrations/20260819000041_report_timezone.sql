-- =============================================================================
-- Relatórios no fuso do estabelecimento (issue #78)
--
-- `created_at` é timestamptz; `created_at::date` usa o fuso do servidor, que
-- no Supabase é UTC. Um restaurante em Porto Alegre (UTC−3) que vende das 18h
-- à meia-noite tinha TRÊS HORAS de faturamento por dia caindo no dia seguinte
-- do DRE. O caixa fechava domingo com um valor e o relatório mostrava outro.
--
-- Os padrões pioravam: `p_to date default current_date` resolvia em UTC — às
-- 21h de Porto Alegre, o "hoje" do relatório já era amanhã.
--
-- A correção troca o corte por um intervalo de timestamptz calculado no fuso
-- da loja: [00:00 local do dia inicial, 00:00 local do dia seguinte ao final).
-- Além de correto, é MAIS RÁPIDO — o cast para date impedia o uso do índice
-- em (tenant_id, created_at); a comparação por faixa volta a usá-lo.
--
-- Assinaturas e contratos de saída inalterados: só os PADRÃO dos parâmetros
-- de data mudam, de `current_date` para nulo (resolvido no fuso da loja).
-- =============================================================================

alter table public.tenants
  add column if not exists timezone text not null default 'America/Sao_Paulo';

comment on column public.tenants.timezone is
  'Fuso IANA do estabelecimento. Define onde o dia começa e termina nos relatórios.';

-- Fuso inválido não falha no cadastro, falha em TODO relatório depois — e aí
-- ninguém liga uma coisa à outra. CHECK não serve: a validação precisa
-- consultar pg_timezone_names.
create or replace function public.validate_tenant_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'fuso horário desconhecido: %', new.timezone
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists tenants_validate_timezone on public.tenants;
create trigger tenants_validate_timezone
  before insert or update of timezone on public.tenants
  for each row execute function public.validate_tenant_timezone();

-- -----------------------------------------------------------------------------
-- tenant_timezone(p_tenant_id uuid)
-- Contrato: (uuid) -> text — fuso da loja, com o padrão brasileiro para quem
-- ainda não configurou. Existe para as funções em `language sql`, que não têm
-- onde guardar uma variável.
-- -----------------------------------------------------------------------------
create or replace function public.tenant_timezone(p_tenant_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(t.timezone, 'America/Sao_Paulo')
  from public.tenants t where t.id = p_tenant_id;
$$;

grant execute on function public.tenant_timezone(uuid) to authenticated, service_role;

-- =============================================================================
-- dre_report — contrato de saída inalterado.
-- =============================================================================
create or replace function public.dre_report(
  p_tenant_id uuid,
  p_from      date default null,
  p_to        date default null
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
  v_tz           text;
  v_hoje         date;
  v_from         date;
  v_to           date;
  v_start        timestamptz;
  v_end          timestamptz;
begin
  if not public.can_access_tenant(p_tenant_id) then
    raise exception 'nao_autorizado' using errcode = '42501';
  end if;

  v_tz := public.tenant_timezone(p_tenant_id);
  v_hoje := (now() at time zone v_tz)::date;
  v_from := coalesce(p_from, v_hoje - 30);
  v_to := coalesce(p_to, v_hoje);
  v_start := v_from::timestamp at time zone v_tz;
  v_end := (v_to + 1)::timestamp at time zone v_tz;

  -- Receita: pedidos efetivamente concluídos no período.
  select coalesce(sum(o.subtotal), 0), coalesce(sum(o.delivery_fee), 0),
         coalesce(sum(o.discount), 0), count(*)
    into v_revenue, v_delivery, v_discounts, v_orders
  from public.orders o
  where o.tenant_id = p_tenant_id
    and o.status in ('delivered', 'completed')
    and o.created_at >= v_start and o.created_at < v_end;

  -- CMV realizado: custo dos lotes que saíram por causa desses pedidos.
  select coalesce(sum(m.quantity * m.unit_cost), 0) into v_cmv
  from public.stock_movements m
  join public.orders o on o.id = m.order_id
  where m.tenant_id = p_tenant_id
    and m.type = 'out'
    and o.status in ('delivered', 'completed')
    and o.created_at >= v_start and o.created_at < v_end;

  -- Despesas do período por natureza. `due_date` é date: não tem fuso.
  select coalesce(sum(a.amount) filter (where coalesce(c.is_fixed, true)), 0),
         coalesce(sum(a.amount) filter (where c.is_fixed = false), 0)
    into v_fixed, v_variable
  from public.financial_accounts a
  left join public.expense_categories c on c.id = a.category_id
  where a.tenant_id = p_tenant_id
    and a.direction = 'payable'
    and a.status <> 'canceled'
    and a.due_date between v_from and v_to;

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

-- =============================================================================
-- cash_flow_report — contrato de saída inalterado. O DIA também é local: um
-- movimento das 22h pertence ao caixa daquela noite, não ao do dia seguinte.
-- =============================================================================
create or replace function public.cash_flow_report(
  p_tenant_id uuid,
  p_from      date default null,
  p_to        date default null
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
  with janela as (
    select public.tenant_timezone(p_tenant_id) as tz
  ), limites as (
    select tz,
           coalesce(p_from, (now() at time zone tz)::date - 30) as d_ini,
           coalesce(p_to, (now() at time zone tz)::date) as d_fim
    from janela
  ), faixa as (
    select tz, d_ini, d_fim,
           d_ini::timestamp at time zone tz as t_ini,
           (d_fim + 1)::timestamp at time zone tz as t_fim
    from limites
  ), dias as (
    select generate_series(d_ini, d_fim, interval '1 day')::date as day from faixa
  ), movimentos as (
    select (m.created_at at time zone f.tz)::date as day,
           sum(m.amount) filter (where m.type in ('sale', 'supply', 'opening')) as inflow,
           sum(m.amount) filter (where m.type in ('withdrawal', 'refund')) as outflow
    from public.cash_movements m, faixa f
    where m.tenant_id = p_tenant_id
      and public.can_access_tenant(p_tenant_id)
      and m.created_at >= f.t_ini and m.created_at < f.t_fim
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

-- =============================================================================
-- profit_projection — contrato de saída inalterado. O "hoje" da base de
-- cálculo passa a ser o do estabelecimento.
-- =============================================================================
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
  v_hoje       date;
begin
  if not public.can_access_tenant(p_tenant_id) then
    raise exception 'nao_autorizado' using errcode = '42501';
  end if;

  v_hoje := (now() at time zone public.tenant_timezone(p_tenant_id))::date;
  v_dre := public.dre_report(p_tenant_id, v_hoje - v_days, v_hoje);

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

-- =============================================================================
-- top_products_report — contrato de saída inalterado.
-- =============================================================================
create or replace function public.top_products_report(
  p_tenant_id uuid,
  p_from      date default null,
  p_to        date default null,
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
  with faixa as (
    select coalesce(p_from, (now() at time zone tz)::date - 30)::timestamp at time zone tz as t_ini,
           (coalesce(p_to, (now() at time zone tz)::date) + 1)::timestamp at time zone tz as t_fim
    from (select public.tenant_timezone(p_tenant_id) as tz) cfg
  )
  select oi.product_id, oi.product_name,
         sum(oi.quantity), sum(oi.total), count(distinct oi.order_id)::integer
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  cross join faixa f
  where oi.tenant_id = p_tenant_id
    and public.can_access_tenant(p_tenant_id)
    and o.status in ('delivered', 'completed')
    and o.created_at >= f.t_ini and o.created_at < f.t_fim
  group by oi.product_id, oi.product_name
  order by sum(oi.total) desc
  limit greatest(p_limit, 0);
$$;

-- =============================================================================
-- marketplace_orders_report — contrato de saída inalterado.
-- =============================================================================
create or replace function public.marketplace_orders_report(
  p_tenant_id uuid,
  p_from      date default null,
  p_to        date default null
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
  with faixa as (
    select coalesce(p_from, (now() at time zone tz)::date - 30)::timestamp at time zone tz as t_ini,
           (coalesce(p_to, (now() at time zone tz)::date) + 1)::timestamp at time zone tz as t_fim
    from (select public.tenant_timezone(p_tenant_id) as tz) cfg
  )
  select o.origin::text, count(*)::integer, coalesce(sum(o.total), 0),
         case when count(*) = 0 then 0 else round(coalesce(sum(o.total), 0) / count(*), 2) end
  from public.orders o
  cross join faixa f
  where o.tenant_id = p_tenant_id
    and public.can_access_tenant(p_tenant_id)
    and o.status in ('delivered', 'completed')
    and o.created_at >= f.t_ini and o.created_at < f.t_fim
  group by o.origin
  order by 3 desc;
$$;
