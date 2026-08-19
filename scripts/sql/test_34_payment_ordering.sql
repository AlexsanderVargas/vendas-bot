-- =============================================================================
-- Ordem dos eventos de pagamento (migration 20260819000043).
--
-- Gateway não garante ordem de entrega. O que este teste trava é a garantia de
-- que a cobrança só ANDA para a frente: nenhum evento atrasado devolve um
-- pedido pago para "aguardando pagamento", nem ressuscita um estorno.
-- =============================================================================
\set ON_ERROR_STOP on

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","app_metadata":{}}', false);

create temporary table t_ordem_pedido as
select ((public.checkout_order(
  '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'takeaway',
  jsonb_build_array(jsonb_build_object(
    'productId', '20000000-0000-0000-0000-0000000000b1', 'quantity', 1))
))->'order'->>'id')::uuid as id;

insert into public.payments (tenant_id, order_id, provider, provider_payment_id, method, amount)
values ('10000000-0000-0000-0000-000000000001', (select id from t_ordem_pedido),
        'mercadopago', 'MP-ORDEM', 'pix', 7.00);

-- --------------------------------------------------------------------------
-- 1. A escada de status: cada degrau é um degrau acima.
-- --------------------------------------------------------------------------
select test.assert(
  public.payment_status_rank('pending') < public.payment_status_rank('processing')
  and public.payment_status_rank('processing') < public.payment_status_rank('approved')
  and public.payment_status_rank('approved') < public.payment_status_rank('refunded'),
  'a cobrança tem uma ordem: pendente, processando, aprovado, estornado');

select test.assert(
  public.payment_status_rank('rejected') = public.payment_status_rank('approved')
  and public.payment_status_rank('canceled') = public.payment_status_rank('expired'),
  'os desfechos empatam: nenhum deles vira outro');

-- --------------------------------------------------------------------------
-- 2. Aprovação normal.
-- --------------------------------------------------------------------------
select public.apply_payment_status('mercadopago', 'MP-ORDEM', 'approved', 'EVT-ORD-1',
                                   'payment.updated', '{"status":"approved"}'::jsonb);

select test.assert(
  (select status from public.payments where provider_payment_id = 'MP-ORDEM') = 'approved'
  and (select payment_status from public.orders o, t_ordem_pedido p where o.id = p.id) = 'paid',
  'aprovação marca a cobrança e o pedido como pagos');

-- --------------------------------------------------------------------------
-- 3. O `pending` que chegou atrasado. É o caso real do Mercado Pago, que
--    dispara os dois eventos quase juntos.
-- --------------------------------------------------------------------------
create temporary table t_atrasado as
select public.apply_payment_status('mercadopago', 'MP-ORDEM', 'pending', 'EVT-ORD-2',
                                   'payment.updated', '{"status":"pending"}'::jsonb) as r;

select test.assert(
  (select status from public.payments where provider_payment_id = 'MP-ORDEM') = 'approved',
  'evento atrasado não rebaixa a cobrança');

select test.assert(
  (select payment_status from public.orders o, t_ordem_pedido p where o.id = p.id) = 'paid',
  'e o pedido continua pago na tela do cliente e na do caixa');

select test.assert(
  ((select r from t_atrasado)->>'ok')::boolean
  and ((select r from t_atrasado)->>'duplicated')::boolean is false
  and ((select r from t_atrasado)->>'orderPaymentStatus') = 'paid',
  'a resposta devolve o status que de fato vale, sem fingir erro');

select test.assert(
  (select processed_at is not null from public.payment_events
    where provider_event_id = 'EVT-ORD-2'),
  'o evento fora de ordem fica registrado e encerrado: é prova do que o gateway mandou');

-- --------------------------------------------------------------------------
-- 4. Estorno anda para a frente; o `approved` que vier depois, não.
-- --------------------------------------------------------------------------
select public.apply_payment_status('mercadopago', 'MP-ORDEM', 'refunded', 'EVT-ORD-3');

select test.assert(
  (select payment_status from public.orders o, t_ordem_pedido p where o.id = p.id) = 'refunded',
  'estorno é aceito depois da aprovação');

select public.apply_payment_status('mercadopago', 'MP-ORDEM', 'approved', 'EVT-ORD-4');

select test.assert(
  (select status from public.payments where provider_payment_id = 'MP-ORDEM') = 'refunded'
  and (select payment_status from public.orders o, t_ordem_pedido p where o.id = p.id) = 'refunded',
  'aprovação atrasada não ressuscita o dinheiro que já voltou');

-- --------------------------------------------------------------------------
-- 5. Reenvio do MESMO evento continua sendo duplicata, não desordem.
-- --------------------------------------------------------------------------
select test.assert(
  (public.apply_payment_status('mercadopago', 'MP-ORDEM', 'refunded', 'EVT-ORD-3')
    ->>'duplicated')::boolean,
  'reenvio do mesmo evento segue reconhecido como duplicata');

select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
