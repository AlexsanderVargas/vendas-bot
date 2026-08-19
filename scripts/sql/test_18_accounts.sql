-- =============================================================================
-- Asserções de contas a pagar/receber: parcelamento, baixa e status derivado.
-- =============================================================================
\set ON_ERROR_STOP on

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);

insert into public.expense_categories (id, tenant_id, name, is_fixed) values
  ('c1000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Aluguel', true),
  ('c1000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Insumos', false);

-- ------------------------------ parcelamento ---------------------------------
-- 100,00 em 3 parcelas: 33,34 + 33,33 + 33,33 = 100,00 exatos.
create temporary table t_parcelas as
select public.create_installments('payable', 'Compra de insumos', 100.00, 3::smallint,
  current_date, 'a0000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000002') as r;

select test.assert(
  ((select r from t_parcelas)->>'created')::int = 3,
  'parcelamento cria uma conta por parcela');

select test.assert(
  (select sum(amount) from public.financial_accounts
   where group_id = ((select r from t_parcelas)->>'groupId')::uuid) = 100.00,
  'soma das parcelas bate exatamente com o total');

select test.assert(
  (select amount from public.financial_accounts
   where group_id = ((select r from t_parcelas)->>'groupId')::uuid and installment = 1) = 33.34,
  'resto da divisão vai na primeira parcela');

select test.assert(
  (select count(distinct due_date) from public.financial_accounts
   where group_id = ((select r from t_parcelas)->>'groupId')::uuid) = 3,
  'parcelas vencem em meses diferentes');

select test.assert(
  (select description from public.financial_accounts
   where group_id = ((select r from t_parcelas)->>'groupId')::uuid and installment = 2)
    = 'Compra de insumos (2/3)',
  'descrição identifica a parcela');

select test.assert(
  ((public.create_installments('payable', 'Inválida', 0, 1::smallint))->>'error') = 'parcelas_invalidas',
  'total zero é recusado');

-- --------------------------- status derivado ---------------------------------
create temporary table t_conta as
select id from public.financial_accounts
where group_id = ((select r from t_parcelas)->>'groupId')::uuid and installment = 1;

select test.assert(
  (select status from public.financial_accounts where id = (select id from t_conta)) = 'open',
  'conta nova com vencimento hoje fica aberta');

-- Baixa parcial.
create temporary table t_parcial as
select public.settle_account((select id from t_conta), 10.00) as r;

select test.assert(
  ((select r from t_parcial)->>'status') = 'partially_paid'
  and ((select r from t_parcial)->>'remaining')::numeric = 23.34,
  'baixa parcial atualiza o status e o saldo restante');

-- Baixa maior que o saldo é recusada.
select test.assert(
  ((public.settle_account((select id from t_conta), 999.00))->>'error') = 'valor_invalido',
  'baixa maior que o saldo devedor é recusada');

select test.assert(
  ((public.settle_account((select id from t_conta), 0))->>'error') = 'valor_invalido',
  'baixa de valor zero é recusada');

-- Quitação.
select test.assert(
  ((public.settle_account((select id from t_conta), 23.34))->>'status') = 'paid',
  'quitação marca a conta como paga');

select test.assert(
  (select paid_at is not null from public.financial_accounts where id = (select id from t_conta)),
  'quitação carimba a data de pagamento');

-- Vencida.
insert into public.financial_accounts (tenant_id, direction, description, amount, due_date)
values ('10000000-0000-0000-0000-000000000001', 'payable', 'Conta atrasada', 50.00, current_date - 5);

select test.assert(
  (select status from public.financial_accounts where description = 'Conta atrasada') = 'overdue',
  'conta com vencimento passado nasce vencida');

select test.assert_denied(
  $$insert into public.financial_accounts (tenant_id, direction, description, amount, due_date, paid_amount)
    values ('10000000-0000-0000-0000-000000000001', 'payable', 'Paga demais', 50.00, current_date, 60.00)$$,
  'valor pago acima do total é rejeitado');

select test.assert_denied(
  $$insert into public.financial_accounts (tenant_id, direction, description, amount, due_date, installment, installments)
    values ('10000000-0000-0000-0000-000000000001', 'payable', 'Parcela inválida', 50.00, current_date, 5, 3)$$,
  'parcela maior que o total de parcelas é rejeitada');

-- Baixa com sessão de caixa gera a movimentação correspondente.
create temporary table t_caixa_conta as
select ((public.open_cash_session(0))->>'sessionId')::uuid as id;

create temporary table t_conta2 as
select id from public.financial_accounts where description = 'Conta atrasada';

select public.settle_account((select id from t_conta2), 50.00, (select id from t_caixa_conta));

select test.assert(
  (select count(*) from public.cash_movements
   where session_id = (select id from t_caixa_conta) and type = 'withdrawal') = 1,
  'baixa de conta a pagar vira sangria no caixa');

-- Autorização. A verificação é do VÍNCULO no banco, não do claim do JWT
-- (migration 42): um claim que diz "sou funcionário daqui" não basta.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000c1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);
select test.assert(
  ((public.settle_account((select id from t_conta), 1.00))->>'error') = 'nao_autorizado',
  'quem não é funcionário não baixa título, nem com o claim dizendo que é');

-- E o funcionário de verdade segue sem alcançar a loja vizinha.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);
select test.assert(
  ((public.settle_account('99999999-9999-9999-9999-999999999999', 1.00))->>'error')
    = 'conta_nao_encontrada',
  'título inexistente responde conta_nao_encontrada');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","app_metadata":{}}', false);
set role authenticated;
select test.assert((select count(*) from public.financial_accounts) = 0, 'cliente não vê o financeiro');
reset role;

select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
