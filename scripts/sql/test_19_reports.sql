-- =============================================================================
-- Asserções dos relatórios: DRE, fluxo de caixa, projeção e ranking.
-- =============================================================================
\set ON_ERROR_STOP on

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);

create temporary table t_dre as
select public.dre_report('10000000-0000-0000-0000-000000000001',
  current_date - 30, current_date) as r;

select test.assert(
  ((select r from t_dre)->>'revenue')::numeric > 0,
  'DRE apura receita dos pedidos concluídos no período');

select test.assert(
  ((select r from t_dre)->>'orderCount')::int > 0,
  'DRE conta os pedidos do período');

select test.assert(
  ((select r from t_dre)->>'averageTicket')::numeric > 0,
  'ticket médio é calculado');

select test.assert(
  ((select r from t_dre)->>'grossProfit')::numeric
    = round(((select r from t_dre)->>'revenue')::numeric - ((select r from t_dre)->>'cmv')::numeric, 2),
  'lucro bruto é receita menos CMV');

select test.assert(
  ((select r from t_dre)->>'netProfit')::numeric
    = round(((select r from t_dre)->>'grossProfit')::numeric
            - ((select r from t_dre)->>'fixedExpenses')::numeric
            - ((select r from t_dre)->>'variableExpenses')::numeric, 2),
  'lucro líquido desconta despesas fixas e variáveis');

select test.assert(
  ((select r from t_dre)->>'cmv')::numeric > 0,
  'CMV vem das movimentações de estoque dos pedidos (baixa automática)');

-- O CMV é histórico: encarecer o insumo hoje não muda o resultado apurado.
create temporary table t_cmv_antes as select ((select r from t_dre)->>'cmv')::numeric as valor;
update public.ingredients set average_cost = average_cost * 10
  where tenant_id = '10000000-0000-0000-0000-000000000001';
select test.assert(
  (public.dre_report('10000000-0000-0000-0000-000000000001', current_date - 30, current_date)->>'cmv')::numeric
    = (select valor from t_cmv_antes),
  'CMV apurado não muda quando o custo do insumo sobe depois da venda');

-- Período sem movimento.
select test.assert(
  (public.dre_report('10000000-0000-0000-0000-000000000001',
    current_date - 400, current_date - 370)->>'revenue')::numeric = 0
  and (public.dre_report('10000000-0000-0000-0000-000000000001',
    current_date - 400, current_date - 370)->>'netMarginPercent')::numeric = 0,
  'período sem vendas não divide por zero');

-- --------------------------- fluxo de caixa ---------------------------------
select test.assert(
  (select count(*) from public.cash_flow_report('10000000-0000-0000-0000-000000000001',
    current_date - 6, current_date)) = 7,
  'fluxo de caixa devolve uma linha por dia, mesmo sem movimento');

select test.assert(
  (select running_balance from public.cash_flow_report('10000000-0000-0000-0000-000000000001',
    current_date - 6, current_date) order by day desc limit 1) is not null,
  'saldo acumulado é calculado');

select test.assert(
  (select bool_and(net = inflow - outflow) from public.cash_flow_report(
    '10000000-0000-0000-0000-000000000001', current_date - 6, current_date)),
  'resultado diário é entradas menos saídas');

-- ----------------------------- projeção -------------------------------------
create temporary table t_proj as
select public.profit_projection('10000000-0000-0000-0000-000000000001', 30, 30) as r;

select test.assert(
  ((select r from t_proj)->>'projectedRevenue')::numeric
    = round(((select r from t_proj)->>'dailyRevenue')::numeric * 30, 2),
  'projeção multiplica a média diária pelo horizonte');

select test.assert(
  (public.profit_projection('10000000-0000-0000-0000-000000000001', 3, 30)->>'confidence') = 'low',
  'base histórica curta reduz a confiança da projeção');

-- Estabelecimento sem vendas: lido sob service_role, porque o guard de tenant
-- impede que o funcionário de um estabelecimento leia a projeção de outro.
select set_config('request.jwt.claims', '{"role":"service_role"}', false);
select test.assert(
  (public.profit_projection('10000000-0000-0000-0000-000000000002', 30, 30)->>'confidence') = 'low',
  'estabelecimento sem vendas tem confiança baixa');
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);

-- ------------------------------ ranking -------------------------------------
select test.assert(
  (select count(*) from public.top_products_report('10000000-0000-0000-0000-000000000001',
    current_date - 30, current_date, 10)) > 0,
  'ranking lista os produtos vendidos no período');

select test.assert(
  (select bool_and(revenue > 0) from public.top_products_report(
    '10000000-0000-0000-0000-000000000001', current_date - 30, current_date, 10)),
  'ranking traz a receita por produto');

-- Isolamento entre estabelecimentos: o funcionário do tenant 001 não pode ler
-- o relatório do tenant 002 (guard de tenant nas funções SECURITY DEFINER).
select test.assert_denied(
  $q$ select public.dre_report('10000000-0000-0000-0000-000000000002', current_date - 30, current_date) $q$,
  'DRE de outro estabelecimento é negado ao funcionário');

-- O caminho legítimo (próprio estabelecimento) segue acessível.
select test.assert(
  (public.dre_report('10000000-0000-0000-0000-000000000001', current_date - 30, current_date)->>'revenue')::numeric > 0,
  'DRE do próprio estabelecimento permanece acessível');

select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
