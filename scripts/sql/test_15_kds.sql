-- =============================================================================
-- Asserções do KDS: fila de preparo, transições por item e conclusão.
-- =============================================================================
\set ON_ERROR_STOP on

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);

-- Comanda nova com dois itens para a cozinha.
create temporary table t_kds as
select ((public.open_table_order('e0000000-0000-0000-0000-000000000001'))->>'orderId')::uuid as id;

select public.add_order_item((select id from t_kds), '20000000-0000-0000-0000-000000000001', 1,
  array['80000000-0000-0000-0000-000000000001']::uuid[]);
select public.add_order_item((select id from t_kds), '20000000-0000-0000-0000-0000000000b1', 2);

select test.assert(
  (select count(*) from public.kds_queue('10000000-0000-0000-0000-000000000001')
   where order_id = (select id from t_kds)) = 2,
  'itens lançados entram na fila da cozinha');

select test.assert(
  (select bool_and(prep_status = 'pending') from public.kds_queue('10000000-0000-0000-0000-000000000001')
   where order_id = (select id from t_kds)),
  'itens nascem pendentes de preparo');

select test.assert(
  (select waiting_seconds >= 0 from public.kds_queue('10000000-0000-0000-0000-000000000001')
   where order_id = (select id from t_kds) limit 1),
  'fila informa o tempo de espera');

-- Item que não passa pela cozinha sai da fila.
update public.order_items set requires_prep = false
where order_id = (select id from t_kds) and product_name = 'Guaraná 350ml';

select test.assert(
  (select count(*) from public.kds_queue('10000000-0000-0000-0000-000000000001')
   where order_id = (select id from t_kds)) = 1,
  'item que não requer preparo sai da fila');

-- Fluxo do item.
create temporary table t_item_kds as
select id from public.order_items
where order_id = (select id from t_kds) and requires_prep limit 1;

select test.assert(
  ((select public.advance_item_prep((select id from t_item_kds), 'preparing'))->>'ok')::boolean,
  'cozinha inicia o preparo do item');

select test.assert(
  (select started_at is not null from public.order_items where id = (select id from t_item_kds)),
  'início do preparo é carimbado');

select test.assert(
  ((select public.advance_item_prep((select id from t_item_kds), 'pending'))->>'error') = 'transicao_invalida',
  'item em preparo não volta para pendente');

create temporary table t_pronto as
select public.advance_item_prep((select id from t_item_kds), 'ready') as r;

select test.assert(
  ((select r from t_pronto)->>'ok')::boolean
  and ((select r from t_pronto)->>'orderReady')::boolean,
  'último item pronto sinaliza que o pedido inteiro está pronto');

select test.assert(
  (select ready_at is not null from public.order_items where id = (select id from t_item_kds)),
  'conclusão do preparo é carimbada');

select test.assert(
  (select count(*) from public.kds_queue('10000000-0000-0000-0000-000000000001')
   where order_id = (select id from t_kds)) = 0,
  'item pronto sai da fila');

select test.assert(
  ((select public.advance_item_prep((select id from t_item_kds), 'preparing'))->>'ok')::boolean,
  'item pronto pode voltar ao preparo (esfriou)');

select public.advance_item_prep((select id from t_item_kds), 'ready');
select test.assert(
  ((select public.advance_item_prep((select id from t_item_kds), 'served'))->>'ok')::boolean,
  'item pronto pode ser servido');

select test.assert(
  ((select public.advance_item_prep((select id from t_item_kds), 'preparing'))->>'error') = 'transicao_invalida',
  'item servido não volta ao preparo');

-- Autorização entre estabelecimentos.
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000002"}}', false);
select test.assert(
  ((select public.advance_item_prep((select id from t_item_kds), 'preparing'))->>'error') = 'nao_autorizado',
  'cozinha de outro estabelecimento não mexe no item');

select test.assert(
  (select count(*) from public.kds_queue('10000000-0000-0000-0000-000000000001')
   where order_id = (select id from t_kds)) = 0,
  'fila continua consultável por tenant sem vazar itens prontos');

select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
