-- =============================================================================
-- Asserções de pagamento on-line: intenção, idempotência do webhook e
-- reflexo no pedido.
-- =============================================================================
\set ON_ERROR_STOP on

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","app_metadata":{}}', false);

create temporary table t_pag_pedido as
select ((public.checkout_order(
  '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'takeaway',
  jsonb_build_array(jsonb_build_object(
    'productId', '20000000-0000-0000-0000-0000000000b1', 'quantity', 1))
))->'order'->>'id')::uuid as id;

-- A cobrança é criada pelo backend (service_role); aqui simulamos como owner.
insert into public.payments (tenant_id, order_id, provider, provider_payment_id,
                             method, amount, qr_code)
values ('10000000-0000-0000-0000-000000000002',   -- tenant errado de propósito
        (select id from t_pag_pedido), 'mercadopago', 'MP-123', 'pix', 7.00,
        '00020126580014br.gov.bcb.pix...');

select test.assert(
  (select tenant_id from public.payments where provider_payment_id = 'MP-123')
    = '10000000-0000-0000-0000-000000000001',
  'cobrança herda o tenant do pedido');

select test.assert(
  (select status from public.payments where provider_payment_id = 'MP-123') = 'pending',
  'cobrança nasce pendente');

select test.assert_denied(
  $$insert into public.payments (tenant_id, order_id, provider, provider_payment_id, method, amount)
    values ('10000000-0000-0000-0000-000000000001', (select id from t_pag_pedido),
            'mercadopago', 'MP-123', 'pix', 7.00)$$,
  'mesmo id de cobrança no mesmo provedor é rejeitado');

select test.assert_denied(
  $$insert into public.payments (tenant_id, order_id, provider, provider_payment_id, method, amount)
    values ('10000000-0000-0000-0000-000000000001', (select id from t_pag_pedido),
            'stripe', 'ST-1', 'pix', 0)$$,
  'cobrança de valor zero é rejeitada');

-- ------------------------------ webhook --------------------------------------
create temporary table t_evento as
select public.apply_payment_status('mercadopago', 'MP-123', 'approved', 'EVT-1',
  'payment.updated', '{"status":"approved"}'::jsonb) as r;

select test.assert(
  ((select r from t_evento)->>'ok')::boolean
  and ((select r from t_evento)->>'duplicated')::boolean is false
  and ((select r from t_evento)->>'orderPaymentStatus') = 'paid',
  'evento aprovado marca a cobrança e o pedido como pagos');

select test.assert(
  (select payment_status from public.orders where id = (select id from t_pag_pedido)) = 'paid',
  'pedido reflete o pagamento aprovado');

select test.assert(
  (select processed_at is not null from public.payment_events where provider_event_id = 'EVT-1'),
  'evento processado é carimbado');

-- Reenvio do mesmo evento (gateways reenviam): não pode aplicar de novo.
create temporary table t_reenvio as
select public.apply_payment_status('mercadopago', 'MP-123', 'refunded', 'EVT-1',
  'payment.updated', '{"status":"refunded"}'::jsonb) as r;

select test.assert(
  ((select r from t_reenvio)->>'duplicated')::boolean,
  'reenvio do mesmo evento é detectado como duplicado');

select test.assert(
  (select payment_status from public.orders where id = (select id from t_pag_pedido)) = 'paid',
  'reenvio duplicado não altera o pedido');

select test.assert(
  (select count(*) from public.payment_events where provider_event_id = 'EVT-1') = 1,
  'evento duplicado não gera segundo registro');

-- Estorno posterior, com id de evento novo.
select public.apply_payment_status('mercadopago', 'MP-123', 'refunded', 'EVT-2',
  'payment.refunded', '{"status":"refunded"}'::jsonb);
select test.assert(
  (select payment_status from public.orders where id = (select id from t_pag_pedido)) = 'refunded',
  'estorno com evento novo atualiza o pedido');

-- Recusa marca o pedido como falho.
insert into public.payments (tenant_id, order_id, provider, provider_payment_id, method, amount)
values ('10000000-0000-0000-0000-000000000001', (select id from t_pag_pedido),
        'stripe', 'ST-9', 'credit_card', 7.00);
select public.apply_payment_status('stripe', 'ST-9', 'rejected', 'EVT-3');
select test.assert(
  (select payment_status from public.orders where id = (select id from t_pag_pedido)) = 'failed',
  'cobrança recusada marca o pedido como falho');

-- Notificação órfã não quebra e fica registrada.
create temporary table t_orfa as
select public.apply_payment_status('asaas', 'NAO-EXISTE', 'approved', 'EVT-4') as r;
select test.assert(
  ((select r from t_orfa)->>'error') = 'pagamento_nao_encontrado',
  'notificação de cobrança desconhecida é sinalizada');
select test.assert(
  (select count(*) from public.payment_events where provider_event_id = 'EVT-4') = 1,
  'notificação órfã fica registrada para diagnóstico');

-- ------------------------------------ RLS ------------------------------------
set role authenticated;
select test.assert(
  (select count(*) from public.payments) = 2,
  'cliente acompanha as cobranças dos próprios pedidos');
reset role;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', false);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c2","app_metadata":{}}', false);
set role authenticated;
select test.assert((select count(*) from public.payments) = 0,
  'cliente não vê cobranças de pedidos alheios');
reset role;

select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
set role anon;
select test.assert((select count(*) from public.payments) = 0, 'anônimo não vê cobranças');
reset role;

-- ------------------------ credenciais de gateway -----------------------------
insert into public.payment_settings (tenant_id, default_provider,
  mercadopago_access_token, mercadopago_webhook_secret, allow_on_delivery)
values ('10000000-0000-0000-0000-000000000001', 'mercadopago', 'APP_USR-xxx', 'segredo', true);

select test.assert(
  (public.tenant_payment_options('10000000-0000-0000-0000-000000000001')->>'defaultProvider') = 'mercadopago'
  and (public.tenant_payment_options('10000000-0000-0000-0000-000000000001')->'providers') = '["mercadopago"]'::jsonb,
  'opções de pagamento listam apenas provedores configurados');

select test.assert(
  ((public.tenant_payment_options('10000000-0000-0000-0000-000000000001')->>'allowOnDelivery')::boolean),
  'pagamento na entrega é sinalizado');

select test.assert(
  public.tenant_payment_options('10000000-0000-0000-0000-000000000002') is null,
  'estabelecimento sem configuração não devolve opções');

-- Segredos não podem vazar para o navegador.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);
set role authenticated;
select test.assert(
  (select count(*) from public.payment_settings) = 0,
  'nem o funcionário lê as credenciais de gateway (só service_role)');
reset role;

set role anon;
select test.assert((select count(*) from public.payment_settings) = 0,
  'anônimo não lê credenciais');
reset role;

select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
