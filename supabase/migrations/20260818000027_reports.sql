-- =============================================================================
-- Migration: DRE simplificado, fluxo de caixa e projeção de lucro
-- Fase 5 / PBI (issue #30) — Financeiro e Caixa
-- =============================================================================

-- -----------------------------------------------------------------------------
-- dre_report(p_tenant_id uuid, p_from date, p_to date)
-- Contrato ESTÁVEL: -> jsonb
--   { "revenue": numeric, "deliveryRevenue": numeric, "discounts": numeric,
--     "cmv": numeric, "grossProfit": numeric, "grossMarginPercent": numeric,
--     "fixedExpenses": numeric, "variableExpenses": numeric,
--     "netProfit": numeric, "netMarginPercent": numeric,
--     "orderCount": int, "averageTicket": numeric }
--
--   O CMV vem das MOVIMENTAÇÕES DE ESTOQUE dos pedidos do período
--   (quantidade x custo do lote consumido), e não do custo médio atual: o
--   resultado do mês passado não pode mudar porque o insumo encareceu hoje.
--   Pedidos sem ficha técnica contribuem CMV zero — o gestor vê isso pela
--   diferença entre margem bruta esperada e apurada.
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- cash_flow_report(p_tenant_id uuid, p_from date, p_to date)
-- Contrato ESTÁVEL: -> setof (day date, inflow numeric, outflow numeric,
--   net numeric, running_balance numeric)
--   Entradas e saídas efetivas de caixa por dia, com saldo acumulado.
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- profit_projection(p_tenant_id uuid, p_lookback_days int, p_horizon_days int)
-- Contrato ESTÁVEL: -> jsonb
--   { "basisDays": int, "dailyRevenue": numeric, "dailyNetProfit": numeric,
--     "horizonDays": int, "projectedRevenue": numeric,
--     "projectedNetProfit": numeric, "confidence": text }
--
--   Projeção linear a partir da média diária observada. confidence é
--   'low' com menos de 7 dias de histórico ou nenhuma venda — projetar
--   crescimento sobre base curta enganaria mais do que ajudaria.
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- top_products_report(p_tenant_id uuid, p_from date, p_to date, p_limit int)
-- Contrato ESTÁVEL: -> setof (product_id uuid, product_name text,
--   quantity numeric, revenue numeric, order_count int)
-- -----------------------------------------------------------------------------
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
    and o.status in ('delivered', 'completed')
    and o.created_at::date between p_from and p_to
  group by oi.product_id, oi.product_name
  order by sum(oi.total) desc
  limit greatest(p_limit, 0);
$$;

grant execute on function public.dre_report(uuid, date, date) to authenticated;
grant execute on function public.cash_flow_report(uuid, date, date) to authenticated;
grant execute on function public.profit_projection(uuid, integer, integer) to authenticated;
grant execute on function public.top_products_report(uuid, date, date, integer) to authenticated;
