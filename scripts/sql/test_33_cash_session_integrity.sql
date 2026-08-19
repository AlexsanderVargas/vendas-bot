-- =============================================================================
-- Sessão de caixa e fronteira do estabelecimento (migration 20260819000042).
--
-- settle_account aceitava qualquer id de sessão: um funcionário lançava
-- movimento dentro do caixa de outra loja, que fechava com uma diferença
-- inexplicável. A defesa principal é a chave estrangeira composta — o teste
-- exercita as duas camadas, a declarativa e a mensagem amigável.
-- =============================================================================
\set ON_ERROR_STOP on
\set t1 '10000000-0000-0000-0000-000000000001'
\set t2 '10000000-0000-0000-0000-000000000002'
\set a1 '00000000-0000-0000-0000-0000000000a1'
\set c1 '00000000-0000-0000-0000-0000000000c1'
\set cx1 'cc000000-0000-0000-0000-000000000001'
\set cx2 'cc000000-0000-0000-0000-000000000002'
\set cxf 'cc000000-0000-0000-0000-000000000003'

-- Estado determinístico: só um caixa aberto por operador é permitido.
update public.cash_sessions
  set status = 'closed', closed_at = now(), counted_amount = coalesce(counted_amount, 0)
  where status = 'open';

insert into public.cash_sessions (id, tenant_id, opened_by, status, opening_amount) values
  (:'cx1', :'t1', :'a1', 'open', 0),
  (:'cx2', :'t2', :'c1', 'open', 0);

insert into public.cash_sessions (id, tenant_id, opened_by, status, opening_amount,
                                  closed_at, counted_amount)
values (:'cxf', :'t1', :'a1', 'closed', 0, now(), 0);

select set_config('request.jwt.claim.sub', :'a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);

select public.create_installments('payable', 'Título do teste de sessão', 90.00, 1::smallint,
                                  current_date + 5);

create temporary table t_titulo as
select id from public.financial_accounts where description like 'Título do teste de sessão%';

-- --------------------------------------------------------------------------
-- 1. O ataque: baixar título da própria loja lançando no caixa da vizinha.
-- --------------------------------------------------------------------------
select test.assert(
  ((select public.settle_account(t.id, 10.00, :'cx2') from t_titulo t)->>'error') = 'sessao_invalida',
  'sessão de caixa de outro estabelecimento é recusada');

select test.assert(
  (select count(*) from public.cash_movements where session_id = :'cx2') = 0,
  'nada foi lançado no caixa da outra loja');

select test.assert(
  (select paid_amount from public.financial_accounts f, t_titulo t where f.id = t.id) = 0,
  'e o título não foi baixado pela metade — a recusa acontece antes de escrever');

-- --------------------------------------------------------------------------
-- 2. Caixa fechado não recebe lançamento novo: o valor já foi conferido.
-- --------------------------------------------------------------------------
select test.assert(
  ((select public.settle_account(t.id, 10.00, :'cxf') from t_titulo t)->>'error') = 'sessao_invalida',
  'caixa fechado é recusado');

-- --------------------------------------------------------------------------
-- 3. O caminho legítimo segue funcionando.
-- --------------------------------------------------------------------------
select test.assert(
  ((select public.settle_account(t.id, 10.00, :'cx1') from t_titulo t)->>'ok')::boolean,
  'baixa com o caixa aberto da própria loja é aceita');

select test.assert(
  (select count(*) from public.cash_movements
    where session_id = :'cx1' and type = 'withdrawal' and amount = 10.00) = 1,
  'a baixa vira sangria no caixa certo');

-- --------------------------------------------------------------------------
-- 4. Por que a correção precisava ser DENTRO de settle_account.
--
--    `tenant_id` do movimento é derivado da sessão por trigger. Uma escrita
--    direta com a sessão da outra loja não fica "meio dentro, meio fora": ela
--    cai inteira na outra loja — e é por isso que a RLS a barra. Já
--    settle_account é SECURITY DEFINER e não passa por RLS nenhuma.
-- --------------------------------------------------------------------------
insert into public.cash_movements (id, tenant_id, session_id, type, method, amount, reason)
values ('cd000000-0000-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000001', :'cx2', 'withdrawal', 'cash', 5.00, 'Prova');

select test.assert(
  (select tenant_id from public.cash_movements where id = 'cd000000-0000-0000-0000-000000000001')
    = :'t2',
  'o trigger reescreve o tenant_id do movimento com o da sessão');

delete from public.cash_movements where id = 'cd000000-0000-0000-0000-000000000001';

-- O helper test.assert_denied não serve aqui: a recusa chega como no_data_found
-- (o trigger não enxerga a sessão da outra loja por causa da RLS), e não como
-- violação de privilégio. O importante é que o INSERT não acontece.
set role authenticated;
do $$
begin
  begin
    insert into public.cash_movements (tenant_id, session_id, type, method, amount, reason)
    values ('10000000-0000-0000-0000-000000000001',
            'cc000000-0000-0000-0000-000000000002', 'withdrawal', 'cash', 5.00, 'Fraude');
    raise exception 'FALHOU: funcionário conseguiu lançar no caixa da outra loja';
  exception
    when insufficient_privilege or no_data_found or check_violation
      or foreign_key_violation then
      raise notice 'ok - funcionário não lança direto no caixa da outra loja (bloqueado: %)', sqlerrm;
  end;
end $$;
reset role;

select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
