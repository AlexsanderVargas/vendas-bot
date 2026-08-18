-- =============================================================================
-- Asserções do carrinho persistente e das sugestões de upsell.
-- =============================================================================
\set ON_ERROR_STOP on

-- Produto de bebida no tenant 1 para servir de sugestão.
insert into public.products (id, tenant_id, category_id, name, price, is_active, is_available) values
  ('20000000-0000-0000-0000-0000000000b1', '10000000-0000-0000-0000-000000000001',
   '60000000-0000-0000-0000-000000000002', 'Guaraná 350ml', 7.00, true, true),
  ('20000000-0000-0000-0000-0000000000b2', '10000000-0000-0000-0000-000000000001',
   '60000000-0000-0000-0000-000000000002', 'Suco de laranja', 9.00, true, false); -- esgotado

-- Regra: quem leva algo de "Lanches" recebe sugestão de bebida.
insert into public.upsell_rules (tenant_id, trigger_category_id, suggested_product_id, sort_order) values
  ('10000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001',
   '20000000-0000-0000-0000-0000000000b1', 1),
  ('10000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001',
   '20000000-0000-0000-0000-0000000000b2', 2);

select test.assert(
  (select count(*) from public.suggest_upsell(
     '10000000-0000-0000-0000-000000000001',
     array['60000000-0000-0000-0000-000000000001']::uuid[], '{}', 5)) = 1,
  'sugestão ignora produto esgotado');

select test.assert(
  (select id from public.suggest_upsell(
     '10000000-0000-0000-0000-000000000001',
     array['60000000-0000-0000-0000-000000000001']::uuid[], '{}', 5))
   = '20000000-0000-0000-0000-0000000000b1',
  'sugestão casa com a categoria presente no carrinho');

select test.assert(
  (select count(*) from public.suggest_upsell(
     '10000000-0000-0000-0000-000000000001',
     array['60000000-0000-0000-0000-000000000003']::uuid[], '{}', 5)) = 0,
  'sugestão não dispara para categoria sem regra');

select test.assert(
  (select count(*) from public.suggest_upsell(
     '10000000-0000-0000-0000-000000000001',
     array['60000000-0000-0000-0000-000000000001']::uuid[],
     array['20000000-0000-0000-0000-0000000000b1']::uuid[], 5)) = 0,
  'sugestão exclui item que já está no carrinho');

-- Regra sem gatilho: sugere sempre.
insert into public.upsell_rules (tenant_id, trigger_category_id, suggested_product_id, sort_order)
values ('10000000-0000-0000-0000-000000000001', null, '20000000-0000-0000-0000-0000000000b1', 0);

select test.assert(
  (select count(*) from public.suggest_upsell(
     '10000000-0000-0000-0000-000000000001', '{}', '{}', 5)) = 1,
  'regra sem categoria de gatilho sugere sempre');

select test.assert(
  (select count(*) from public.suggest_upsell(
     '10000000-0000-0000-0000-000000000001', '{}', '{}', 0)) = 0,
  'limite zero não devolve sugestões');

-- ---------------------------- carrinho por cliente ---------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","app_metadata":{}}', false);
set role authenticated;

insert into public.carts (id, tenant_id, customer_id)
values ('90000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
        '30000000-0000-0000-0000-000000000001');

-- tenant_id proposital ERRADO: o trigger deve derivá-lo do carrinho.
insert into public.cart_items (cart_id, tenant_id, product_id, line_key, quantity) values
  ('90000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002',
   '20000000-0000-0000-0000-000000000001', 'prod-1::opt-a', 2);

select test.assert(
  (select tenant_id from public.cart_items where cart_id = '90000000-0000-0000-0000-000000000001')
    = '10000000-0000-0000-0000-000000000001',
  'item do carrinho herda o tenant do carrinho');

select test.assert_denied(
  $$insert into public.cart_items (cart_id, tenant_id, product_id, line_key, quantity)
    values ('90000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
            '20000000-0000-0000-0000-000000000001', 'prod-1::opt-a', 1)$$,
  'linha duplicada no carrinho é rejeitada (soma quantidade em vez de duplicar)');

select test.assert_denied(
  $$insert into public.cart_items (cart_id, tenant_id, product_id, line_key, quantity)
    values ('90000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
            '20000000-0000-0000-0000-000000000001', 'prod-1::zero', 0)$$,
  'item de carrinho com quantidade zero é rejeitado');

select test.assert_denied(
  $$insert into public.carts (tenant_id, customer_id)
    values ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002')$$,
  'cliente não cria carrinho em nome de outro cliente');
reset role;

-- Cliente B não enxerga o carrinho do cliente A.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', false);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c2","app_metadata":{}}', false);
set role authenticated;
select test.assert((select count(*) from public.carts) = 0, 'cliente B não vê o carrinho do cliente A');
select test.assert((select count(*) from public.cart_items) = 0, 'cliente B não vê itens do carrinho alheio');
reset role;

-- Staff enxerga carrinhos do próprio tenant (base para reengajamento).
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);
set role authenticated;
select test.assert((select count(*) from public.carts) = 1, 'staff enxerga carrinhos do próprio tenant');
reset role;

select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
