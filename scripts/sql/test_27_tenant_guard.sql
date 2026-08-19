-- =============================================================================
-- Guard de tenant nas funções SECURITY DEFINER (migration 20260819000035).
-- Trava contra regressão o isolamento entre estabelecimentos: nenhum usuário
-- autenticado pode ler (ou escrever, no estoque) dados de um tenant do qual não
-- é funcionário. O service_role (worker e triggers de ingestão de marketplace)
-- mantém acesso pleno.
-- =============================================================================
\set ON_ERROR_STOP on
\set t1 '10000000-0000-0000-0000-000000000001'

-- --------------------------------------------------------------------------
-- 1. Funcionário do próprio estabelecimento: acesso liberado (caminho legítimo).
-- --------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);

select test.assert(
  public.dre_report(:'t1')->>'revenue' is not null,
  'funcionário lê o DRE do próprio estabelecimento');

select test.assert(
  public.cash_session_summary(
    coalesce((select id from public.cash_sessions where tenant_id = :'t1' limit 1),
             '00000000-0000-0000-0000-000000000000'))->>'movementCount' is not null,
  'funcionário lê o resumo de caixa do próprio estabelecimento');

-- --------------------------------------------------------------------------
-- 2. Cliente B2C (autenticado, sem vínculo com loja): negado em toda função.
-- --------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000c1","app_metadata":{}}', false);

-- Funções jsonb/plpgsql: levantam insufficient_privilege (42501).
select test.assert_denied(
  $$ select public.dre_report('10000000-0000-0000-0000-000000000001') $$,
  'cliente não lê o DRE de um estabelecimento');
select test.assert_denied(
  $$ select public.profit_projection('10000000-0000-0000-0000-000000000001') $$,
  'cliente não lê a projeção de lucro');
select test.assert_denied(
  $$ select public.cash_session_summary(
       (select id from public.cash_sessions where tenant_id = '10000000-0000-0000-0000-000000000001' limit 1)) $$,
  'cliente não lê o resumo de caixa');

-- Funções de tabela: devolvem conjunto vazio ao não-autorizado.
select test.assert(
  (select count(*) from public.kds_queue_v2(:'t1')) = 0,
  'cliente não enxerga a fila da cozinha (KDS v2)');
select test.assert(
  (select count(*) from public.kds_queue(:'t1')) = 0,
  'cliente não enxerga a fila da cozinha (KDS v1)');
select test.assert(
  (select count(*) from public.stock_alerts(:'t1')) = 0,
  'cliente não enxerga alertas de estoque');
select test.assert(
  (select count(*) from public.marketplace_orders_report(:'t1')) = 0,
  'cliente não enxerga o relatório de canais');
select test.assert(
  (select count(*) from public.top_products_report(:'t1')) = 0,
  'cliente não enxerga o ranking de produtos');
select test.assert(
  (select count(*) from public.cash_flow_report(:'t1', current_date, current_date)
   where inflow <> 0 or outflow <> 0) = 0,
  'cliente não enxerga movimento no fluxo de caixa de um estabelecimento');

-- Escrita de estoque: bloqueada com o erro previsto no contrato, sem baixar nada.
select test.assert(
  (public.consume_stock('b0000000-0000-0000-0000-000000000002', 1)->>'error') = 'nao_autorizado',
  'cliente não dá baixa no estoque de um estabelecimento');

-- --------------------------------------------------------------------------
-- 3. service_role: acesso pleno (worker de marketplace e triggers dependem).
-- --------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{"role":"service_role"}', false);

select test.assert(
  public.dre_report(:'t1')->>'revenue' is not null,
  'service_role lê o DRE (worker e triggers de marketplace precisam)');
select test.assert(
  (public.consume_stock('b0000000-0000-0000-0000-000000000002', 1)->>'error') is distinct from 'nao_autorizado',
  'service_role passa pelo guard do consume_stock (baixa automática do marketplace)');

select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
