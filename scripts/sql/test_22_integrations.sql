-- =============================================================================
-- Asserções da base de integração: ingestão de pedido externo, idempotência,
-- mapeamento de cardápio e isolamento.
-- =============================================================================
\set ON_ERROR_STOP on

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);

insert into public.integrations (id, tenant_id, channel, status, external_store_id, store_name)
values ('11100000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
        'ifood', 'connected', 'merchant-abc', 'Lancheria T1 no iFood'),
       ('11100000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001',
        'ubereats', 'connected', 'store-xyz', 'Lancheria T1 no Uber Eats');

select test.assert_denied(
  $$insert into public.integrations (tenant_id, channel)
    values ('10000000-0000-0000-0000-000000000001', 'ifood')$$,
  'dois canais iguais no mesmo estabelecimento é rejeitado');

-- ------------------------- mapeamento de cardápio ----------------------------
insert into public.integration_item_map
  (tenant_id, integration_id, product_id, external_item_id, external_name)
values ('10000000-0000-0000-0000-000000000002',  -- tenant errado de propósito
        '11100000-0000-0000-0000-000000000001',
        '20000000-0000-0000-0000-000000000001', 'IFD-XSALADA', 'X-Salada');

select test.assert(
  (select tenant_id from public.integration_item_map where external_item_id = 'IFD-XSALADA')
    = '10000000-0000-0000-0000-000000000001',
  'mapeamento herda o tenant da integração');

select test.assert_denied(
  $$insert into public.integration_item_map (tenant_id, integration_id, product_id, external_item_id)
    values ('10000000-0000-0000-0000-000000000001', '11100000-0000-0000-0000-000000000001',
            '20000000-0000-0000-0000-000000000003', 'IFD-CHOPP')$$,
  'mapear produto de outro estabelecimento é rejeitado');

select test.assert_denied(
  $$insert into public.integration_item_map (tenant_id, integration_id, product_id, external_item_id)
    values ('10000000-0000-0000-0000-000000000001', '11100000-0000-0000-0000-000000000001',
            '20000000-0000-0000-0000-0000000000b1', 'IFD-XSALADA')$$,
  'mesmo item externo mapeado duas vezes é rejeitado');

select test.assert_denied(
  $$insert into public.integration_item_map (tenant_id, integration_id, external_item_id)
    values ('10000000-0000-0000-0000-000000000001', '11100000-0000-0000-0000-000000000001', 'IFD-VAZIO')$$,
  'mapeamento precisa apontar para produto ou opcional');

-- ---------------------------- ingestão de pedido -----------------------------
create temporary table t_ifood as
select public.ingest_external_order('11100000-0000-0000-0000-000000000001', jsonb_build_object(
  'externalOrderId', 'IFOOD-0001',
  'displayId', '4821',
  'channel', 'delivery',
  'subtotal', 51.80, 'discount', 5.00, 'deliveryFee', 8.00, 'total', 54.80,
  'paymentStatus', 'paid',
  'items', jsonb_build_array(
    jsonb_build_object('externalItemId', 'IFD-XSALADA', 'name', 'X-Salada',
      'quantity', 2, 'unitPrice', 25.90,
      'options', jsonb_build_array(jsonb_build_object('name', 'Bem passada', 'priceDelta', 2.50))),
    jsonb_build_object('externalItemId', 'IFD-DESCONHECIDO', 'name', 'Combo promocional',
      'quantity', 1, 'unitPrice', 0))
)) as r;

select test.assert(
  ((select r from t_ifood)->>'ok')::boolean
  and ((select r from t_ifood)->>'orderNumber')::bigint > 0,
  'pedido do iFood vira pedido interno numerado');

select test.assert(
  (select origin from public.orders where id = ((select r from t_ifood)->>'orderId')::uuid) = 'ifood',
  'pedido externo é marcado com a origem');

select test.assert(
  (select external_display_id from public.orders
   where id = ((select r from t_ifood)->>'orderId')::uuid) = '4821',
  'código curto do parceiro é preservado para o entregador');

select test.assert(
  (select payment_status from public.orders
   where id = ((select r from t_ifood)->>'orderId')::uuid) = 'paid',
  'pedido já pago no marketplace entra como pago');

-- Preço vem do parceiro, não do catálogo interno.
select test.assert(
  (select total from public.orders where id = ((select r from t_ifood)->>'orderId')::uuid) = 54.80,
  'total do pedido respeita os valores do marketplace');

select test.assert(
  (select subtotal from public.orders where id = ((select r from t_ifood)->>'orderId')::uuid) = 51.80,
  'subtotal do parceiro não é recalculado pelos itens');

select test.assert(
  ((select r from t_ifood)->'unmappedItems') = '["Combo promocional"]'::jsonb,
  'item sem mapeamento é reportado ao operador');

select test.assert(
  (select count(*) from public.order_items
   where order_id = ((select r from t_ifood)->>'orderId')::uuid and product_id is null) = 1,
  'item não mapeado entra no pedido mesmo sem produto interno');

select test.assert(
  (select product_id from public.order_items
   where order_id = ((select r from t_ifood)->>'orderId')::uuid
     and product_name = 'X-Salada') = '20000000-0000-0000-0000-000000000001',
  'item mapeado aponta para o produto interno (permite baixa de estoque)');

select test.assert(
  (select jsonb_array_length(selected_options) from public.order_items
   where order_id = ((select r from t_ifood)->>'orderId')::uuid
     and product_name = 'X-Salada') = 1,
  'opcionais do parceiro viram snapshot no item');

select test.assert(
  (select delivery_address->>'handledBy' from public.orders
   where id = ((select r from t_ifood)->>'orderId')::uuid) = 'ifood',
  'entrega sem endereço exposto registra que o marketplace faz a logística');

-- ----------------------------- idempotência ----------------------------------
create temporary table t_repetido as
select public.ingest_external_order('11100000-0000-0000-0000-000000000001', jsonb_build_object(
  'externalOrderId', 'IFOOD-0001', 'channel', 'delivery',
  'subtotal', 51.80, 'total', 51.80,
  'items', jsonb_build_array())) as r;

select test.assert(
  ((select r from t_repetido)->>'duplicated')::boolean
  and ((select r from t_repetido)->>'orderId')::uuid = ((select r from t_ifood)->>'orderId')::uuid,
  'reentrega do mesmo pedido devolve o pedido existente sem duplicar');

select test.assert(
  (select count(*) from public.orders where external_order_id = 'IFOOD-0001') = 1,
  'pedido externo não é duplicado');

-- ---------------------- divergência de total ---------------------------------
create temporary table t_divergente as
select public.ingest_external_order('11100000-0000-0000-0000-000000000002', jsonb_build_object(
  'externalOrderId', 'UBER-0001', 'channel', 'takeaway',
  'subtotal', 30.00, 'discount', 0, 'deliveryFee', 0, 'total', 35.00,
  'items', jsonb_build_array(jsonb_build_object(
    'externalItemId', 'UB-1', 'name', 'Item', 'quantity', 1, 'unitPrice', 30.00)))) as r;

select test.assert(
  ((select r from t_divergente)->>'totalMismatch')::numeric = 5.00,
  'divergência entre total declarado e composição é reportada, não absorvida');

-- ------------------------------ canal pausado --------------------------------
update public.integrations set is_receiving = false
where id = '11100000-0000-0000-0000-000000000002';

select test.assert(
  (public.ingest_external_order('11100000-0000-0000-0000-000000000002', jsonb_build_object(
    'externalOrderId', 'UBER-0002', 'channel', 'takeaway', 'total', 10,
    'items', jsonb_build_array()))->>'error') = 'canal_pausado',
  'canal pausado recusa novos pedidos');

update public.integrations set is_receiving = true
where id = '11100000-0000-0000-0000-000000000002';

select test.assert(
  (public.ingest_external_order('11100000-0000-0000-0000-000000000001', jsonb_build_object(
    'channel', 'delivery', 'total', 10, 'items', jsonb_build_array()))->>'error') = 'payload_invalido',
  'payload sem identificador externo é recusado');

-- ------------------------------- eventos -------------------------------------
create temporary table t_evt as
select public.record_integration_event('11100000-0000-0000-0000-000000000001',
  'EVT-IFOOD-1', 'PLC', 'IFOOD-0001', '{"code":"PLC"}'::jsonb) as r;

select test.assert(
  ((select r from t_evt)->>'duplicated')::boolean is false,
  'primeiro evento é registrado');

select test.assert(
  (public.record_integration_event('11100000-0000-0000-0000-000000000001',
    'EVT-IFOOD-1', 'PLC', 'IFOOD-0001')->>'duplicated')::boolean,
  'reentrega do mesmo evento é detectada como duplicada');

select test.assert(
  (select count(*) from public.integration_events where external_event_id = 'EVT-IFOOD-1') = 1,
  'evento duplicado não gera segundo registro');

select test.assert(
  (select tenant_id from public.integration_events where external_event_id = 'EVT-IFOOD-1')
    = '10000000-0000-0000-0000-000000000001',
  'evento herda o tenant da integração');

-- ---------------- o pedido externo entra no fluxo interno --------------------
select test.assert(
  (select count(*) from public.kds_queue('10000000-0000-0000-0000-000000000001')
   where order_id = ((select r from t_ifood)->>'orderId')::uuid) > 0,
  'itens do pedido externo aparecem na fila da cozinha');

select public.advance_order_status(((select r from t_ifood)->>'orderId')::uuid, 'confirmed');
select test.assert(
  (select stock_deducted_at is not null from public.orders
   where id = ((select r from t_ifood)->>'orderId')::uuid),
  'confirmação do pedido externo dispara a baixa de estoque pela ficha técnica');

-- ------------------------------------ RLS ------------------------------------
set role authenticated;
select test.assert(
  (select count(*) from public.integration_credentials) = 0,
  'nem o funcionário lê as credenciais de integração (só service_role)');
select test.assert(
  (select count(*) from public.integrations) = 2,
  'staff enxerga as integrações do próprio estabelecimento');
reset role;

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000002"}}', false);
set role authenticated;
select test.assert(
  (select count(*) from public.integrations) = 0,
  'staff de outro estabelecimento não vê integrações alheias');
select test.assert(
  (select count(*) from public.integration_events) = 0,
  'eventos de integração são isolados por estabelecimento');
reset role;

select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
set role anon;
select test.assert((select count(*) from public.integrations) = 0, 'anônimo não vê integrações');
reset role;

-- ------------------- fila da cozinha com a origem (v2) -----------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);

select test.assert(
  (select count(*) from public.kds_queue('10000000-0000-0000-0000-000000000001')) =
  (select count(*) from public.kds_queue_v2('10000000-0000-0000-0000-000000000001')),
  'kds_queue_v2 devolve a mesma fila da v1 (contrato da v1 preservado)');

select test.assert(
  (select origin from public.kds_queue_v2('10000000-0000-0000-0000-000000000001')
   where order_id = ((select r from t_ifood)->>'orderId')::uuid limit 1) = 'ifood',
  'fila v2 identifica a origem do pedido para a cozinha');

select test.assert(
  (select external_display_id from public.kds_queue_v2('10000000-0000-0000-0000-000000000001')
   where order_id = ((select r from t_ifood)->>'orderId')::uuid limit 1) = '4821',
  'fila v2 traz o código curto que o entregador informa');

-- ---------------------- desempenho por canal ---------------------------------
select test.assert(
  (select count(*) from public.marketplace_orders_report('10000000-0000-0000-0000-000000000001',
    current_date - 30, current_date)) >= 1,
  'relatório por canal agrupa os pedidos concluídos');

select test.assert(
  (select bool_and(average_ticket >= 0) from public.marketplace_orders_report(
    '10000000-0000-0000-0000-000000000001', current_date - 30, current_date)),
  'ticket médio por canal não fica negativo');

select test.assert(
  (select count(*) from public.marketplace_orders_report('10000000-0000-0000-0000-000000000002',
    current_date - 400, current_date - 370)) = 0,
  'período sem vendas devolve relatório vazio sem erro');
