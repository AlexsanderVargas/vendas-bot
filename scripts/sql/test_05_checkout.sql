-- =============================================================================
-- Asserções do checkout transacional: revalidação de preço, regras de
-- opcionais, entrega e atomicidade.
-- =============================================================================
\set ON_ERROR_STOP on

-- Estado conhecido: modo fixo, sem pedido mínimo.
update public.tenants set delivery_fee_mode = 'fixed', delivery_base_fee = 9.90,
  delivery_min_order = 0, delivery_free_above = null, delivery_eta_minutes = 40
where id = '10000000-0000-0000-0000-000000000001';

-- Endereço do cliente A (criado em test_01).
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","app_metadata":{}}', false);

-- ------------------------- pedido de retirada -------------------------------
with resultado as (
  select public.checkout_order(
    '10000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    'takeaway',
    jsonb_build_array(jsonb_build_object(
      'productId', '20000000-0000-0000-0000-000000000001',
      'quantity', 2,
      'optionIds', jsonb_build_array('80000000-0000-0000-0000-000000000002')))
  ) as r
)
select test.assert(
  (r->>'ok')::boolean
  -- 25,90 + 2,50 (bem passada) = 28,40 x 2 = 56,80; retirada não cobra entrega
  and (r->'order'->>'subtotal')::numeric = 56.80
  and (r->'order'->>'deliveryFee')::numeric = 0
  and (r->'order'->>'total')::numeric = 56.80,
  'checkout de retirada recalcula preço com opcional e não cobra entrega')
from resultado;

select test.assert(
  (select count(*) from public.order_items oi
   join public.orders o on o.id = oi.order_id
   where o.channel = 'takeaway' and o.customer_id = '30000000-0000-0000-0000-000000000001'
     and jsonb_array_length(oi.selected_options) = 1) = 1,
  'snapshot dos opcionais é gravado no item do pedido');

-- ------------------------- pedido de entrega --------------------------------
with resultado as (
  select public.checkout_order(
    '10000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    'delivery',
    jsonb_build_array(jsonb_build_object(
      'productId', '20000000-0000-0000-0000-0000000000b1', 'quantity', 1)),
    '40000000-0000-0000-0000-000000000001'
  ) as r
)
select test.assert(
  (r->>'ok')::boolean
  and (r->'order'->>'deliveryFee')::numeric = 9.90
  and (r->'order'->>'total')::numeric = 16.90
  and (r->'order'->>'etaMinutes')::int = 40,
  'checkout de entrega aplica a taxa cotada e o tempo estimado')
from resultado;

-- O cliente já tinha um pedido de entrega vindo do teste 01: olhar o mais recente.
select test.assert(
  (select delivery_address->>'street' from public.orders
   where channel = 'delivery' and customer_id = '30000000-0000-0000-0000-000000000001'
   order by created_at desc, order_number desc limit 1) = 'Rua A',
  'endereço é congelado no pedido (snapshot)');

-- ------------------------- recusas esperadas --------------------------------
select test.assert(
  (public.checkout_order('10000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001', 'takeaway', '[]'::jsonb)->>'error') = 'carrinho_vazio',
  'carrinho vazio é recusado');

select test.assert(
  (public.checkout_order('10000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001', 'takeaway',
    jsonb_build_array(jsonb_build_object(
      'productId', '20000000-0000-0000-0000-0000000000b2', 'quantity', 1)))->>'error')
   = 'produto_indisponivel',
  'produto esgotado é recusado');

select test.assert(
  (public.checkout_order('10000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001', 'takeaway',
    jsonb_build_array(jsonb_build_object(
      'productId', '20000000-0000-0000-0000-000000000003', 'quantity', 1)))->>'error')
   = 'produto_indisponivel',
  'produto de outro tenant é recusado');

select test.assert(
  (public.checkout_order('10000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001', 'takeaway',
    jsonb_build_array(jsonb_build_object(
      'productId', '20000000-0000-0000-0000-000000000001', 'quantity', 1)))->>'error')
   = 'opcionais_obrigatorios',
  'grupo obrigatório sem escolha é recusado');

select test.assert(
  (public.checkout_order('10000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001', 'takeaway',
    jsonb_build_array(jsonb_build_object(
      'productId', '20000000-0000-0000-0000-000000000001', 'quantity', 1,
      'optionIds', jsonb_build_array('80000000-0000-0000-0000-000000000001',
                                     '80000000-0000-0000-0000-000000000002'))))->>'error')
   = 'opcionais_obrigatorios',
  'mais escolhas que o máximo do grupo é recusado');

select test.assert(
  (public.checkout_order('10000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001', 'takeaway',
    jsonb_build_array(jsonb_build_object(
      'productId', '20000000-0000-0000-0000-0000000000b1', 'quantity', 1,
      'optionIds', jsonb_build_array('80000000-0000-0000-0000-000000000001'))))->>'error')
   = 'opcional_invalido',
  'opcional de outro produto é recusado');

select test.assert(
  (public.checkout_order('10000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001', 'delivery',
    jsonb_build_array(jsonb_build_object(
      'productId', '20000000-0000-0000-0000-0000000000b1', 'quantity', 1)),
    null)->>'error') = 'endereco_invalido',
  'entrega sem endereço é recusada');

select test.assert(
  (public.checkout_order('10000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000002', 'takeaway',
    jsonb_build_array(jsonb_build_object(
      'productId', '20000000-0000-0000-0000-0000000000b1', 'quantity', 1)))->>'error')
   = 'nao_autorizado',
  'checkout em nome de outro cliente é recusado');

select test.assert(
  (public.checkout_order('10000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001', 'takeaway',
    jsonb_build_array(jsonb_build_object(
      'productId', '20000000-0000-0000-0000-0000000000b1', 'quantity', 0)))->>'error')
   = 'produto_indisponivel',
  'quantidade zero é recusada');

-- Nenhuma recusa pode ter deixado pedido órfão: 2 pedidos criados acima
-- somados aos 4 que já existiam do teste 01.
select test.assert(
  (select count(*) from public.orders where customer_id = '30000000-0000-0000-0000-000000000001') = 5,
  'recusas não criam pedido parcial (atomicidade)');

-- ------------------------- pedido mínimo ------------------------------------
update public.tenants set delivery_min_order = 100.00
  where id = '10000000-0000-0000-0000-000000000001';
select test.assert(
  (public.checkout_order('10000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001', 'delivery',
    jsonb_build_array(jsonb_build_object(
      'productId', '20000000-0000-0000-0000-0000000000b1', 'quantity', 1)),
    '40000000-0000-0000-0000-000000000001')->>'error')
   = 'entrega_indisponivel:pedido_minimo',
  'pedido abaixo do mínimo é recusado no checkout');
update public.tenants set delivery_min_order = 0
  where id = '10000000-0000-0000-0000-000000000001';

-- ------------------------- limpeza do carrinho ------------------------------
insert into public.carts (id, tenant_id, customer_id)
values ('90000000-0000-0000-0000-0000000000ff', '10000000-0000-0000-0000-000000000001',
        '30000000-0000-0000-0000-000000000001')
on conflict (tenant_id, customer_id) do nothing;

select public.checkout_order('10000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001', 'takeaway',
  jsonb_build_array(jsonb_build_object(
    'productId', '20000000-0000-0000-0000-0000000000b1', 'quantity', 1)));

select test.assert(
  (select count(*) from public.carts
   where tenant_id = '10000000-0000-0000-0000-000000000001'
     and customer_id = '30000000-0000-0000-0000-000000000001') = 0,
  'carrinho é esvaziado após o checkout');

select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
