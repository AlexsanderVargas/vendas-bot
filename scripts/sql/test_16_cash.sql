-- =============================================================================
-- Asserções do caixa: sessão, movimentos, conferência e fechamento.
-- =============================================================================
\set ON_ERROR_STOP on

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);

create temporary table t_caixa as
select ((public.open_cash_session(200.00, 'Turno da tarde'))->>'sessionId')::uuid as id;

select test.assert((select id from t_caixa) is not null, 'caixa é aberto com fundo de troco');

select test.assert(
  (select count(*) from public.cash_movements where session_id = (select id from t_caixa)
     and type = 'opening') = 1,
  'fundo de troco vira movimento de abertura');

select test.assert(
  ((public.open_cash_session(100.00))->>'error') = 'sessao_ja_aberta',
  'operador não abre dois caixas ao mesmo tempo');

-- Vendas em formas diferentes.
insert into public.cash_movements (tenant_id, session_id, type, method, amount, created_by) values
  ('10000000-0000-0000-0000-000000000001', (select id from t_caixa), 'sale', 'cash', 150.00, '00000000-0000-0000-0000-0000000000a1'),
  ('10000000-0000-0000-0000-000000000001', (select id from t_caixa), 'sale', 'credit_card', 300.00, '00000000-0000-0000-0000-0000000000a1'),
  ('10000000-0000-0000-0000-000000000001', (select id from t_caixa), 'sale', 'pix', 80.00, '00000000-0000-0000-0000-0000000000a1'),
  ('10000000-0000-0000-0000-000000000001', (select id from t_caixa), 'supply', 'cash', 50.00, '00000000-0000-0000-0000-0000000000a1'),
  ('10000000-0000-0000-0000-000000000001', (select id from t_caixa), 'withdrawal', 'cash', 100.00, '00000000-0000-0000-0000-0000000000a1');

create temporary table t_resumo as
select public.cash_session_summary((select id from t_caixa)) as r;

select test.assert(
  ((select r from t_resumo)->>'sales')::numeric = 530.00,
  'resumo soma as vendas de todas as formas de pagamento');

-- Só dinheiro fica na gaveta: 200 (abertura) + 150 (venda) + 50 (suprimento) - 100 (sangria) = 300
select test.assert(
  ((select r from t_resumo)->>'expectedCash')::numeric = 300.00,
  'valor esperado em gaveta considera apenas dinheiro');

select test.assert(
  (((select r from t_resumo)->'byMethod'->>'credit_card')::numeric = 300.00
   and ((select r from t_resumo)->'byMethod'->>'pix')::numeric = 80.00),
  'resumo detalha as vendas por forma de pagamento');

select test.assert(
  ((select r from t_resumo)->>'withdrawals')::numeric = 100.00,
  'sangria é somada separadamente');

-- Fechamento com sobra de 10.
create temporary table t_fechamento as
select public.close_cash_session((select id from t_caixa), 310.00, 'Conferido') as r;

select test.assert(
  ((select r from t_fechamento)->>'ok')::boolean
  and ((select r from t_fechamento)->>'expectedCash')::numeric = 300.00
  and ((select r from t_fechamento)->>'difference')::numeric = 10.00,
  'fechamento apura a diferença entre contado e esperado');

select test.assert(
  (select status from public.cash_sessions where id = (select id from t_caixa)) = 'closed',
  'sessão é marcada como fechada');

select test.assert(
  ((select public.close_cash_session((select id from t_caixa), 300.00))->>'error') = 'sessao_ja_fechada',
  'caixa fechado não fecha de novo');

select test.assert_denied(
  $$insert into public.cash_movements (tenant_id, session_id, type, method, amount)
    values ('10000000-0000-0000-0000-000000000001', (select id from t_caixa), 'sale', 'cash', 10)$$,
  'caixa fechado não aceita nova movimentação');

-- Falta em caixa é registrada com sinal negativo.
create temporary table t_caixa2 as
select ((public.open_cash_session(100.00))->>'sessionId')::uuid as id;
insert into public.cash_movements (tenant_id, session_id, type, method, amount)
values ('10000000-0000-0000-0000-000000000001', (select id from t_caixa2), 'sale', 'cash', 50.00);

select test.assert(
  ((public.close_cash_session((select id from t_caixa2), 140.00))->>'difference')::numeric = -10.00,
  'falta em caixa é registrada como diferença negativa');

select test.assert_denied(
  $$insert into public.cash_movements (tenant_id, session_id, type, method, amount)
    values ('10000000-0000-0000-0000-000000000001', (select id from t_caixa2), 'sale', 'cash', 0)$$,
  'movimento de valor zero é rejeitado');

-- Autorização.
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000002"}}', false);
select test.assert(
  ((public.close_cash_session((select id from t_caixa), 100.00))->>'error') = 'nao_autorizado',
  'caixa de outro estabelecimento não pode ser fechado');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","app_metadata":{}}', false);
set role authenticated;
select test.assert((select count(*) from public.cash_sessions) = 0, 'cliente não vê o caixa');
select test.assert((select count(*) from public.cash_movements) = 0, 'cliente não vê movimentos de caixa');
reset role;

select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
