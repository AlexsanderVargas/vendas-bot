-- =============================================================================
-- Asserções de insumos, unidades e fornecedores.
-- =============================================================================
\set ON_ERROR_STOP on

-- Conversões de unidade.
select test.assert(public.convert_to_base(1, 'kg', 'g') = 1000, 'converte kg para g');
select test.assert(public.convert_to_base(500, 'g', 'kg') = 0.5, 'converte g para kg');
select test.assert(public.convert_to_base(2, 'l', 'ml') = 2000, 'converte l para ml');
select test.assert(public.convert_to_base(7, 'un', 'un') = 7, 'mesma unidade não altera o valor');
select test.assert(public.convert_to_base(1, 'kg', 'l') is null, 'conversão entre massa e volume é indefinida');
select test.assert(public.convert_to_base(1, 'un', 'g') is null, 'unidade avulsa não converte para massa');

-- Cadastros do tenant 1.
insert into public.suppliers (id, tenant_id, name, document) values
  ('a0000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Distribuidora Sul', '12345678000199'),
  ('a0000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Hortifruti Central', null);

insert into public.ingredients (id, tenant_id, name, base_unit, minimum_stock, is_perishable, shelf_life_days) values
  ('b0000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Carne bovina', 'g', 2000, true, 5),
  ('b0000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Pão de hambúrguer', 'un', 20, false, null),
  ('b0000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'Queijo', 'g', 1000, true, 10);

select test.assert_denied(
  $$insert into public.ingredients (tenant_id, name, base_unit)
    values ('10000000-0000-0000-0000-000000000001', 'Carne bovina', 'g')$$,
  'insumo com nome repetido no mesmo tenant é rejeitado');

-- SKU é opcional: vários insumos sem SKU precisam coexistir.
select test.assert(
  (select count(*) from public.ingredients
   where tenant_id = '10000000-0000-0000-0000-000000000001' and sku is null) = 3,
  'vários insumos sem SKU coexistem no mesmo tenant');

insert into public.ingredients (tenant_id, name, base_unit, sku)
values ('10000000-0000-0000-0000-000000000001', 'Batata', 'g', 'BAT-01');
select test.assert_denied(
  $$insert into public.ingredients (tenant_id, name, base_unit, sku)
    values ('10000000-0000-0000-0000-000000000001', 'Batata doce', 'g', 'BAT-01')$$,
  'SKU repetido no mesmo tenant é rejeitado');

select test.assert_denied(
  $$insert into public.ingredients (tenant_id, name, base_unit, shelf_life_days)
    values ('10000000-0000-0000-0000-000000000001', 'Alface', 'g', 0)$$,
  'validade de zero dia é rejeitada');

select test.assert_denied(
  $$insert into public.suppliers (tenant_id, name, document)
    values ('10000000-0000-0000-0000-000000000001', 'Outro', '123')$$,
  'documento fora do formato de CPF/CNPJ é rejeitado');

-- Vínculo insumo-fornecedor com conversão de unidade de compra.
insert into public.ingredient_suppliers
  (tenant_id, ingredient_id, supplier_id, purchase_unit, purchase_factor, last_price, is_preferred)
values
  ('10000000-0000-0000-0000-000000000002',  -- tenant errado de propósito
   'b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
   'kg', 1000, 42.90, true);

select test.assert(
  (select tenant_id from public.ingredient_suppliers
   where ingredient_id = 'b0000000-0000-0000-0000-000000000001')
    = '10000000-0000-0000-0000-000000000001',
  'vínculo insumo-fornecedor herda o tenant do insumo');

select test.assert_denied(
  $$insert into public.ingredient_suppliers
      (tenant_id, ingredient_id, supplier_id, purchase_unit, purchase_factor)
    values ('10000000-0000-0000-0000-000000000001',
            'b0000000-0000-0000-0000-000000000001',
            'a0000000-0000-0000-0000-000000000001', 'kg', 1000)$$,
  'vínculo duplicado entre insumo e fornecedor é rejeitado');

insert into public.ingredient_suppliers
  (tenant_id, ingredient_id, supplier_id, purchase_unit, purchase_factor, is_preferred)
values ('10000000-0000-0000-0000-000000000001',
        'b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002',
        'kg', 1000, false);

select test.assert_denied(
  $$update public.ingredient_suppliers set is_preferred = true
    where ingredient_id = 'b0000000-0000-0000-0000-000000000001'
      and supplier_id = 'a0000000-0000-0000-0000-000000000002'$$,
  'dois fornecedores preferenciais para o mesmo insumo é rejeitado');

select test.assert_denied(
  $$insert into public.ingredient_suppliers
      (tenant_id, ingredient_id, supplier_id, purchase_unit, purchase_factor)
    values ('10000000-0000-0000-0000-000000000001',
            'b0000000-0000-0000-0000-000000000002',
            (select id from public.suppliers where tenant_id = '10000000-0000-0000-0000-000000000002' limit 1),
            'un', 1)$$,
  'fornecedor de outro estabelecimento é rejeitado');

select test.assert_denied(
  $$insert into public.ingredient_suppliers
      (tenant_id, ingredient_id, supplier_id, purchase_unit, purchase_factor)
    values ('10000000-0000-0000-0000-000000000001',
            'b0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'g', 0)$$,
  'fator de conversão zero é rejeitado');

-- Índice de reposição: todos começam zerados, portanto abaixo do mínimo.
select test.assert(
  (select count(*) from public.ingredients
   where tenant_id = '10000000-0000-0000-0000-000000000001'
     and is_active and stock_quantity <= minimum_stock) = 4,
  'insumos sem estoque aparecem como abaixo do mínimo');

-- ------------------------------------ RLS ------------------------------------
select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
set role anon;
select test.assert((select count(*) from public.ingredients) = 0, 'anônimo não vê insumos');
select test.assert((select count(*) from public.suppliers) = 0, 'anônimo não vê fornecedores');
reset role;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","app_metadata":{}}', false);
set role authenticated;
select test.assert((select count(*) from public.ingredients) = 0, 'cliente B2C não vê insumos');
reset role;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);
set role authenticated;
select test.assert((select count(*) from public.ingredients) = 4, 'staff vê os insumos do próprio tenant');
select test.assert_denied(
  $$insert into public.ingredients (tenant_id, name, base_unit)
    values ('10000000-0000-0000-0000-000000000002', 'Invasor', 'g')$$,
  'staff não cria insumo em tenant alheio');
reset role;

select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
