-- =============================================================================
-- Asserções do cardápio estendido (categorias, grupos de opcionais, opções).
-- Depende do seed criado em test_01_core_rls.sql.
-- =============================================================================
\set ON_ERROR_STOP on

insert into public.categories (id, tenant_id, name, sort_order) values
  ('60000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Lanches', 1),
  ('60000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Bebidas', 2),
  ('60000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', 'Chopes', 1);

update public.products set category_id = '60000000-0000-0000-0000-000000000001'
  where id = '20000000-0000-0000-0000-000000000001';

-- tenant_id proposital ERRADO: o trigger deve derivá-lo do produto.
insert into public.product_option_groups (id, tenant_id, product_id, name, selection_type, min_select, max_select) values
  ('70000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002',
   '20000000-0000-0000-0000-000000000001', 'Ponto da carne', 'single', 1, 1);

select test.assert(
  (select tenant_id from public.product_option_groups where id = '70000000-0000-0000-0000-000000000001')
    = '10000000-0000-0000-0000-000000000001',
  'grupo de opcionais herda tenant do produto');

insert into public.product_options (id, tenant_id, group_id, name, price_delta) values
  ('80000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002',
   '70000000-0000-0000-0000-000000000001', 'Ao ponto', 0),
  ('80000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001',
   '70000000-0000-0000-0000-000000000001', 'Bem passada', 2.50);

select test.assert(
  (select bool_and(tenant_id = '10000000-0000-0000-0000-000000000001')
     from public.product_options where group_id = '70000000-0000-0000-0000-000000000001'),
  'opção herda tenant do grupo');

select test.assert_denied(
  $$insert into public.product_option_groups (tenant_id, product_id, name, selection_type, min_select, max_select)
    values ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001',
            'Inválido', 'single', 1, 3)$$,
  'grupo single com max_select > 1 é rejeitado');

select test.assert_denied(
  $$insert into public.product_option_groups (tenant_id, product_id, name, selection_type, min_select, max_select)
    values ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001',
            'Inválido', 'multiple', 3, 2)$$,
  'grupo com min_select > max_select é rejeitado');

select test.assert(
  (select selected_options from public.order_items
     where order_id = '50000000-0000-0000-0000-000000000001' limit 1) = '[]'::jsonb,
  'itens existentes recebem selected_options vazio por padrão');

-- ============================ RLS ===========================================
set role anon;
select test.assert((select count(*) from public.categories) = 3, 'anônimo vê categorias ativas de todos os tenants');
select test.assert((select count(*) from public.product_option_groups) = 1, 'anônimo vê grupos de opcionais ativos');
select test.assert((select count(*) from public.product_options) = 2, 'anônimo vê as opções do cardápio');
select test.assert_denied(
  $$insert into public.categories (tenant_id, name) values ('10000000-0000-0000-0000-000000000001', 'Hack')$$,
  'anônimo não cria categoria');
reset role;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);
set role authenticated;

insert into public.categories (tenant_id, name, sort_order)
values ('10000000-0000-0000-0000-000000000001', 'Sobremesas', 3);
select test.assert(
  (select count(*) from public.categories where tenant_id = '10000000-0000-0000-0000-000000000001') = 3,
  'staff cria categoria no próprio tenant');

select test.assert_denied(
  $$insert into public.categories (tenant_id, name) values ('10000000-0000-0000-0000-000000000002', 'Invasor')$$,
  'staff não cria categoria em tenant alheio');

-- Categoria inativa some do cardápio público mas continua visível ao staff.
update public.categories set is_active = false where id = '60000000-0000-0000-0000-000000000002';
select test.assert(
  (select count(*) from public.categories where tenant_id = '10000000-0000-0000-0000-000000000001') = 3,
  'staff enxerga a própria categoria mesmo inativa');
reset role;

-- Limpa os claims do funcionário: sem isso, current_tenant_id() continuaria
-- devolvendo o tenant e o bloco anônimo enxergaria linhas inativas.
select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
set role anon;
select test.assert(
  (select count(*) from public.categories where id = '60000000-0000-0000-0000-000000000002') = 0,
  'categoria inativa desaparece do cardápio público');
reset role;
