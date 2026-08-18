-- =============================================================================
-- Asserções do rastreamento: linha do tempo, transições e autorização.
-- =============================================================================
\set ON_ERROR_STOP on

-- Pedido novo do cliente A para exercitar o ciclo completo.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","app_metadata":{}}', false);

create temporary table t_pedido as
select ((public.checkout_order(
  '10000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  'takeaway',
  jsonb_build_array(jsonb_build_object(
    'productId', '20000000-0000-0000-0000-0000000000b1', 'quantity', 1))
))->'order'->>'id')::uuid as id;

select test.assert(
  (select count(*) from public.order_status_events e, t_pedido p
   where e.order_id = p.id and e.status = 'placed') = 1,
  'criação do pedido registra o primeiro evento da linha do tempo');

-- Cliente pode cancelar enquanto o pedido não foi confirmado.
select test.assert(
  ((select public.advance_order_status(p.id, 'canceled') from t_pedido p)->>'ok')::boolean,
  'cliente cancela o próprio pedido ainda não confirmado');

select test.assert(
  (select canceled_at is not null from public.orders o, t_pedido p where o.id = p.id),
  'cancelamento carimba canceled_at automaticamente');

select test.assert(
  (select count(*) from public.order_status_events e, t_pedido p where e.order_id = p.id) = 2,
  'cada mudança de status gera um evento');

-- Para o cliente, confirmar nunca é permitido: a autorização barra antes da
-- transição ser sequer avaliada.
select test.assert(
  ((select public.advance_order_status(p.id, 'confirmed') from t_pedido p)->>'error') = 'nao_autorizado',
  'cliente não confirma pedido nem após cancelá-lo');

-- Novo pedido para o fluxo do estabelecimento.
create temporary table t_pedido2 as
select ((public.checkout_order(
  '10000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  'takeaway',
  jsonb_build_array(jsonb_build_object(
    'productId', '20000000-0000-0000-0000-0000000000b1', 'quantity', 1))
))->'order'->>'id')::uuid as id;

-- Cliente NÃO pode confirmar nem preparar: isso é do estabelecimento.
select test.assert(
  ((select public.advance_order_status(p.id, 'confirmed') from t_pedido2 p)->>'error') = 'nao_autorizado',
  'cliente não confirma o próprio pedido');
reset role;

-- Staff conduz o fluxo.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);

select test.assert(
  ((select public.advance_order_status(p.id, 'confirmed', 'aceito pelo caixa') from t_pedido2 p)->>'ok')::boolean,
  'staff confirma o pedido');

select test.assert(
  (select note from public.order_status_events e, t_pedido2 p
   where e.order_id = p.id and e.status = 'confirmed') = 'aceito pelo caixa',
  'observação da transição é gravada no evento');

select test.assert(
  ((select public.advance_order_status(p.id, 'delivered') from t_pedido2 p)->>'error') = 'transicao_invalida',
  'staff não pula de confirmado direto para entregue');

select public.advance_order_status((select id from t_pedido2), 'preparing');
select public.advance_order_status((select id from t_pedido2), 'ready');
select test.assert(
  ((select public.advance_order_status(p.id, 'delivered') from t_pedido2 p)->>'ok')::boolean,
  'fluxo completo até entregue é aceito');

select test.assert(
  (select delivered_at is not null from public.orders o, t_pedido2 p where o.id = p.id),
  'entrega carimba delivered_at automaticamente');

select test.assert(
  (select count(*) from public.order_status_events e, t_pedido2 p where e.order_id = p.id) = 5,
  'linha do tempo acumula todos os estados percorridos');

-- Pedido cancelado não volta a avançar, nem para o estabelecimento.
select test.assert(
  ((select public.advance_order_status(p.id, 'confirmed') from t_pedido p)->>'error') = 'transicao_invalida',
  'pedido cancelado não volta a avançar nem pelo estabelecimento');

-- Staff de outro tenant não mexe no pedido.
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000002"}}', false);
select test.assert(
  ((select public.advance_order_status(p.id, 'completed') from t_pedido2 p)->>'error') = 'nao_autorizado',
  'staff de outro tenant não altera o pedido');

-- RLS da linha do tempo.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', false);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c2","app_metadata":{}}', false);
set role authenticated;
select test.assert(
  (select count(*) from public.order_status_events) = 0,
  'cliente B não enxerga a linha do tempo dos pedidos do cliente A');
reset role;

select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
