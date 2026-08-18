-- =============================================================================
-- Asserções das comandas de mesa: abertura, lançamento e fechamento.
-- =============================================================================
\set ON_ERROR_STOP on

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);

-- Mesa V1 (e0000000-...-0002) está livre.
create temporary table t_comanda as
select public.open_table_order('e0000000-0000-0000-0000-000000000002', 'Aniversário') as r;

select test.assert(
  ((select r from t_comanda)->>'ok')::boolean,
  'comanda é aberta na mesa livre');

select test.assert(
  (select status from public.dining_tables where id = 'e0000000-0000-0000-0000-000000000002') = 'occupied',
  'abrir comanda ocupa a mesa no mesmo commit');

select test.assert(
  ((select public.open_table_order('e0000000-0000-0000-0000-000000000002'))->>'error') = 'comanda_ja_aberta',
  'mesa com comanda aberta não aceita outra');

-- Lançamento de itens: preço vem do banco.
create temporary table t_item as
select public.add_order_item(
  ((select r from t_comanda)->>'orderId')::uuid,
  '20000000-0000-0000-0000-0000000000b1', 2) as r;   -- Guaraná 7,00

select test.assert(
  ((select r from t_item)->>'ok')::boolean
  and ((select r from t_item)->>'unitPrice')::numeric = 7.00
  and ((select r from t_item)->>'orderTotal')::numeric = 14.00,
  'item lançado recalcula o total da comanda');

-- Item com opcional obrigatório respeitado.
select public.add_order_item(
  ((select r from t_comanda)->>'orderId')::uuid,
  '20000000-0000-0000-0000-000000000001', 1,
  array['80000000-0000-0000-0000-000000000002']::uuid[]);  -- X-Salada + bem passada (+2,50)

select test.assert(
  (select total from public.orders where id = ((select r from t_comanda)->>'orderId')::uuid) = 42.40,
  'total acumula os lançamentos seguintes (14,00 + 28,40)');

select test.assert(
  ((public.add_order_item(((select r from t_comanda)->>'orderId')::uuid,
    '20000000-0000-0000-0000-000000000001', 1))->>'error') = 'opcionais_obrigatorios',
  'lançamento sem opcional obrigatório é recusado');

select test.assert(
  ((public.add_order_item(((select r from t_comanda)->>'orderId')::uuid,
    '20000000-0000-0000-0000-000000000003', 1))->>'error') = 'produto_indisponivel',
  'produto de outro estabelecimento é recusado na comanda');

select test.assert(
  ((public.add_order_item(((select r from t_comanda)->>'orderId')::uuid,
    '20000000-0000-0000-0000-0000000000b1', 0))->>'error') = 'produto_indisponivel',
  'quantidade zero é recusada na comanda');

-- Remover item recalcula o total.
delete from public.order_items
where order_id = ((select r from t_comanda)->>'orderId')::uuid
  and product_id = '20000000-0000-0000-0000-0000000000b1';

select test.assert(
  (select total from public.orders where id = ((select r from t_comanda)->>'orderId')::uuid) = 28.40,
  'remover item recalcula o total da comanda');

-- Fechamento coloca a mesa em cobrança.
select test.assert(
  ((select public.close_table_order(((select r from t_comanda)->>'orderId')::uuid))->>'total')::numeric = 28.40,
  'fechar comanda devolve o total');

select test.assert(
  (select status from public.dining_tables where id = 'e0000000-0000-0000-0000-000000000002') = 'billing',
  'fechar comanda coloca a mesa em cobrança');

-- Pedido concluído não aceita mais lançamentos.
select public.advance_order_status(((select r from t_comanda)->>'orderId')::uuid, 'confirmed');
select public.advance_order_status(((select r from t_comanda)->>'orderId')::uuid, 'preparing');
select public.advance_order_status(((select r from t_comanda)->>'orderId')::uuid, 'ready');
select public.advance_order_status(((select r from t_comanda)->>'orderId')::uuid, 'completed');

select test.assert(
  ((public.add_order_item(((select r from t_comanda)->>'orderId')::uuid,
    '20000000-0000-0000-0000-0000000000b1', 1))->>'error') = 'pedido_fechado',
  'comanda concluída não aceita novos itens');

-- Autorização entre estabelecimentos.
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000002"}}', false);
select test.assert(
  ((select public.open_table_order('e0000000-0000-0000-0000-000000000001'))->>'error') = 'nao_autorizado',
  'staff de outro estabelecimento não abre comanda');

select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
