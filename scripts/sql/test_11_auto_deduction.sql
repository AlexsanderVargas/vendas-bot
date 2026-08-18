-- =============================================================================
-- Asserções da baixa automática pela ficha técnica e dos alertas de estoque.
-- =============================================================================
\set ON_ERROR_STOP on

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);

-- Estoque farto e conhecido para os insumos do X-Salada.
update public.ingredients set stock_quantity = 0, average_cost = 0
  where id in ('b0000000-0000-0000-0000-000000000001',
               'b0000000-0000-0000-0000-000000000002',
               'b0000000-0000-0000-0000-000000000003');
delete from public.stock_batches
  where ingredient_id in ('b0000000-0000-0000-0000-000000000001',
                          'b0000000-0000-0000-0000-000000000002',
                          'b0000000-0000-0000-0000-000000000003');

select public.receive_stock('b0000000-0000-0000-0000-000000000001', 10000, 0.045, current_date + 20, null, 'CARNE-1');
select public.receive_stock('b0000000-0000-0000-0000-000000000002', 500, 1.20);
select public.receive_stock('b0000000-0000-0000-0000-000000000003', 5000, 0.06, current_date + 20, null, 'QUEIJO-1');

-- Pedido do cliente A com 2 X-Salada (ficha: carne 150g/10% perda, pão 1un, queijo 30g).
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","app_metadata":{}}', false);

create temporary table t_baixa as
select ((public.checkout_order(
  '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'takeaway',
  jsonb_build_array(jsonb_build_object(
    'productId', '20000000-0000-0000-0000-000000000001', 'quantity', 2,
    'optionIds', jsonb_build_array('80000000-0000-0000-0000-000000000001')))
))->'order'->>'id')::uuid as id;

select test.assert(
  (select stock_quantity from public.ingredients where id = 'b0000000-0000-0000-0000-000000000002') = 500,
  'estoque não é baixado enquanto o pedido não é confirmado');

-- Confirmação dispara a baixa.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);
select public.advance_order_status((select id from t_baixa), 'confirmed');

select test.assert(
  (select stock_quantity from public.ingredients where id = 'b0000000-0000-0000-0000-000000000002') = 498,
  'baixa automática consome 1 pão por unidade vendida');

-- Carne: 150 g com 10% de perda = 166,6667 por unidade; 2 unidades = 333,3334
select test.assert(
  (select round(stock_quantity, 3) from public.ingredients
   where id = 'b0000000-0000-0000-0000-000000000001') = 9666.667,
  'baixa da carne embute a perda de preparo da ficha técnica');

select test.assert(
  (select stock_quantity from public.ingredients where id = 'b0000000-0000-0000-0000-000000000003') = 4940,
  'baixa do queijo acompanha a quantidade vendida');

select test.assert(
  (select stock_deducted_at is not null from public.orders o, t_baixa b where o.id = b.id),
  'pedido é marcado como baixado');

select test.assert(
  (select count(*) from public.stock_movements m, t_baixa b
   where m.order_id = b.id and m.type = 'out') = 3,
  'cada insumo da ficha gera uma movimentação vinculada ao pedido');

-- Idempotência: rodar de novo não baixa duas vezes.
select test.assert(
  ((select public.deduct_order_stock(b.id) from t_baixa b)->>'error') = 'ja_baixado',
  'segunda baixa do mesmo pedido é recusada');

select test.assert(
  (select stock_quantity from public.ingredients where id = 'b0000000-0000-0000-0000-000000000002') = 498,
  'estoque permanece inalterado após tentativa de baixa repetida');

-- Produto sem ficha técnica não quebra a baixa.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","app_metadata":{}}', false);
create temporary table t_sem_ficha as
select ((public.checkout_order(
  '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'takeaway',
  jsonb_build_array(jsonb_build_object(
    'productId', '20000000-0000-0000-0000-0000000000b1', 'quantity', 1))
))->'order'->>'id')::uuid as id;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);
select public.advance_order_status((select id from t_sem_ficha), 'confirmed');

select test.assert(
  (select (public.deduct_order_stock(s.id))->>'error' from t_sem_ficha s) = 'ja_baixado',
  'pedido de produto sem ficha técnica é marcado como baixado sem consumir nada');

-- Falta de estoque não bloqueia a venda, mas é reportada.
update public.ingredients set stock_quantity = 1 where id = 'b0000000-0000-0000-0000-000000000002';
update public.stock_batches set quantity_remaining = 1
  where ingredient_id = 'b0000000-0000-0000-0000-000000000002';

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","app_metadata":{}}', false);
create temporary table t_falta_ped as
select ((public.checkout_order(
  '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'takeaway',
  jsonb_build_array(jsonb_build_object(
    'productId', '20000000-0000-0000-0000-000000000001', 'quantity', 5,
    'optionIds', jsonb_build_array('80000000-0000-0000-0000-000000000001')))
))->'order'->>'id')::uuid as id;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);

create temporary table t_resultado as
select public.deduct_order_stock((select id from t_falta_ped)) as r;

select test.assert(
  ((select r from t_resultado)->>'ok')::boolean
  and jsonb_array_length((select r from t_resultado)->'shortages') = 1,
  'falta de estoque é reportada sem bloquear a venda');

select test.assert(
  ((select r from t_resultado)->'shortages'->0->>'consumed')::numeric = 1,
  'a falta informa quanto foi realmente consumido');

-- ------------------------------- alertas ------------------------------------
select test.assert(
  (select count(*) from public.stock_alerts('10000000-0000-0000-0000-000000000001')
   where kind = 'below_minimum' and ingredient_name = 'Pão de hambúrguer') = 1,
  'insumo abaixo do mínimo aparece nos alertas');

-- Lote vencendo em 3 dias entra no alerta padrão (7 dias).
select public.receive_stock('b0000000-0000-0000-0000-000000000003', 100, 0.06, current_date + 3, null, 'QUEIJO-VENC');
select test.assert(
  (select count(*) from public.stock_alerts('10000000-0000-0000-0000-000000000001')
   where kind = 'expiring' and batch_code = 'QUEIJO-VENC') = 1,
  'lote com validade próxima aparece como vencendo');

select test.assert(
  (select count(*) from public.stock_alerts('10000000-0000-0000-0000-000000000001', 1)
   where batch_code = 'QUEIJO-VENC') = 0,
  'janela de alerta menor exclui o lote que ainda não está no prazo');

select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
