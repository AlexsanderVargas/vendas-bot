-- =============================================================================
-- Estorno de estoque no cancelamento (migration 20260819000040).
--
-- Pedido cancelado depois da baixa devolvia nada ao estoque. Aqui o ciclo
-- inteiro é exercitado: baixa, cancelamento, devolução por lote e a recusa do
-- estorno em duplicidade.
-- =============================================================================
\set ON_ERROR_STOP on
\set t1 '10000000-0000-0000-0000-000000000001'
\set carne 'b0000000-0000-0000-0000-000000000001'
\set pao 'b0000000-0000-0000-0000-000000000002'
\set queijo 'b0000000-0000-0000-0000-000000000003'

-- Estado conhecido para os três insumos do X-Salada.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);

update public.ingredients set stock_quantity = 0 where id in (:'carne', :'pao', :'queijo');
delete from public.stock_batches where ingredient_id in (:'carne', :'pao', :'queijo');

select public.receive_stock(:'carne', 10000, 0.045, current_date + 20, null, 'CARNE-EST');
select public.receive_stock(:'pao', 500, 1.20);
select public.receive_stock(:'queijo', 5000, 0.06, current_date + 20, null, 'QUEIJO-EST');

create temporary table t_antes as
select
  (select stock_quantity from public.ingredients where id = :'carne')  as carne,
  (select stock_quantity from public.ingredients where id = :'pao')    as pao,
  (select stock_quantity from public.ingredients where id = :'queijo') as queijo,
  (select quantity_remaining from public.stock_batches
    where ingredient_id = :'pao' order by received_at limit 1)         as lote_pao;

-- Pedido do cliente A com 2 X-Salada.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","app_metadata":{}}', false);

create temporary table t_estorno as
select ((public.checkout_order(
  '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'takeaway',
  jsonb_build_array(jsonb_build_object(
    'productId', '20000000-0000-0000-0000-000000000001', 'quantity', 2,
    'optionIds', jsonb_build_array('80000000-0000-0000-0000-000000000001')))
))->'order'->>'id')::uuid as id;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);

select public.advance_order_status((select id from t_estorno), 'confirmed');

select test.assert(
  (select stock_quantity from public.ingredients where id = :'pao')
    = (select pao - 2 from t_antes),
  'confirmação baixa o estoque (pré-condição do estorno)');

-- --------------------------------------------------------------------------
-- 1. Cancelar devolve tudo — insumo, lote e o registro da movimentação.
-- --------------------------------------------------------------------------
select public.advance_order_status((select id from t_estorno), 'canceled');

select test.assert(
  (select stock_quantity from public.ingredients where id = :'pao') = (select pao from t_antes)
  and (select round(stock_quantity, 3) from public.ingredients where id = :'carne')
      = (select round(carne, 3) from t_antes)
  and (select stock_quantity from public.ingredients where id = :'queijo') = (select queijo from t_antes),
  'cancelamento devolve os três insumos ao estoque');

select test.assert(
  (select quantity_remaining from public.stock_batches
    where ingredient_id = :'pao' order by received_at limit 1) = (select lote_pao from t_antes),
  'a quantidade volta ao MESMO lote de onde saiu, preservando o custo do CMV');

select test.assert(
  (select count(*) from public.stock_movements m, t_estorno e
    where m.order_id = e.id and m.type = 'in') = 3,
  'cada saída ganha uma entrada compensatória vinculada ao pedido');

select test.assert(
  (select count(*) from public.stock_movements m, t_estorno e
    where m.order_id = e.id and m.type = 'in' and m.reason like 'Estorno do pedido%') = 3,
  'a movimentação de estorno diz de onde veio');

select test.assert(
  (select stock_restored_at is not null from public.orders o, t_estorno e where o.id = e.id),
  'o pedido fica marcado como estornado');

-- --------------------------------------------------------------------------
-- 2. Estorno é uma vez só. Repetir criaria estoque do nada.
-- --------------------------------------------------------------------------
select test.assert(
  ((select public.restore_order_stock(e.id) from t_estorno e)->>'error') = 'ja_estornado',
  'segundo estorno do mesmo pedido é recusado');

select test.assert(
  (select stock_quantity from public.ingredients where id = :'pao') = (select pao from t_antes),
  'estoque permanece correto após tentativa de estorno repetido');

-- --------------------------------------------------------------------------
-- 3. Pedido que nunca foi baixado não tem o que estornar.
-- --------------------------------------------------------------------------
select test.assert(
  (public.restore_order_stock('50000000-0000-0000-0000-000000000002')->>'error') = 'nao_baixado',
  'pedido sem baixa responde nao_baixado, sem inventar movimentação');

-- --------------------------------------------------------------------------
-- 4. O estorno é do TRIGGER, não da rota: cancelamento que não passa por
--    advance_order_status (é o caso do iFood, via cancel_external_order)
--    devolve o estoque do mesmo jeito.
-- --------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","app_metadata":{}}', false);

create temporary table t_parceiro as
select ((public.checkout_order(
  '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'takeaway',
  jsonb_build_array(jsonb_build_object(
    'productId', '20000000-0000-0000-0000-000000000001', 'quantity', 1,
    'optionIds', jsonb_build_array('80000000-0000-0000-0000-000000000001')))
))->'order'->>'id')::uuid as id;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);
select public.advance_order_status((select id from t_parceiro), 'confirmed');

select test.assert(
  (select stock_quantity from public.ingredients where id = :'pao') = (select pao - 1 from t_antes),
  'segundo pedido baixa o estoque (pré-condição)');

-- UPDATE direto na tabela, como faz cancel_external_order.
update public.orders set status = 'canceled' where id = (select id from t_parceiro);

select test.assert(
  (select stock_quantity from public.ingredients where id = :'pao') = (select pao from t_antes),
  'cancelamento fora da rota também devolve o estoque');

-- --------------------------------------------------------------------------
-- 5. A função pública continua respeitando o isolamento entre lojas.
-- --------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","app_metadata":{}}', false);

select test.assert(
  ((select public.restore_order_stock(e.id) from t_estorno e)->>'error') = 'nao_autorizado',
  'cliente não estorna estoque de estabelecimento nenhum');

-- --------------------------------------------------------------------------
-- 6. A função interna é inalcançável por token de usuário.
-- --------------------------------------------------------------------------
set role authenticated;
select test.assert_denied(
  $$ select public.apply_stock_restore('50000000-0000-0000-0000-000000000001') $$,
  'apply_stock_restore não é executável por funcionário nem por cliente');
reset role;

select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
