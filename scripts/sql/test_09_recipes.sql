-- =============================================================================
-- Asserções da ficha técnica e do CMV.
-- =============================================================================
\set ON_ERROR_STOP on

-- Custos médios conhecidos para o cálculo (por unidade base).
update public.ingredients set average_cost = 0.0450 where id = 'b0000000-0000-0000-0000-000000000001'; -- carne: R$ 45/kg
update public.ingredients set average_cost = 1.2000 where id = 'b0000000-0000-0000-0000-000000000002'; -- pão: R$ 1,20/un
update public.ingredients set average_cost = 0.0600 where id = 'b0000000-0000-0000-0000-000000000003'; -- queijo: R$ 60/kg

-- Ficha técnica do X-Salada (produto 20000000-...-0001, preço 25,90).
insert into public.product_recipes (tenant_id, product_id, ingredient_id, quantity, waste_percent) values
  ('10000000-0000-0000-0000-000000000002',  -- tenant errado de propósito
   '20000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 150, 10),
  ('10000000-0000-0000-0000-000000000001',
   '20000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002', 1, 0),
  ('10000000-0000-0000-0000-000000000001',
   '20000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000003', 30, 0);

select test.assert(
  (select tenant_id from public.product_recipes
   where product_id = '20000000-0000-0000-0000-000000000001'
     and ingredient_id = 'b0000000-0000-0000-0000-000000000001')
    = '10000000-0000-0000-0000-000000000001',
  'linha da ficha técnica herda o tenant do produto');

-- Perda de preparo: 150 g com 10% de perda consome 166,6667 g.
select test.assert(
  public.recipe_effective_quantity(150, 10) = 166.6667,
  'quantidade efetiva embute a perda de preparo');

select test.assert(
  public.recipe_effective_quantity(100, 0) = 100,
  'sem perda, a quantidade efetiva é a própria');

-- CMV: carne 166,6667 x 0,045 = 7,50 | pão 1 x 1,20 = 1,20 | queijo 30 x 0,06 = 1,80
select test.assert(
  public.product_cmv('20000000-0000-0000-0000-000000000001') = 10.50,
  'CMV soma quantidade efetiva x custo médio de cada insumo');

select test.assert(
  (public.product_margin('20000000-0000-0000-0000-000000000001')->>'margin')::numeric = 15.40,
  'margem é preço menos CMV');

select test.assert(
  (public.product_margin('20000000-0000-0000-0000-000000000001')->>'marginPercent')::numeric = 59.46,
  'margem percentual é calculada sobre o preço de venda');

select test.assert(
  ((public.product_margin('20000000-0000-0000-0000-000000000001')->>'hasRecipe')::boolean),
  'produto com ficha técnica é sinalizado');

select test.assert(
  public.product_cmv('20000000-0000-0000-0000-0000000000b1') = 0
  and ((public.product_margin('20000000-0000-0000-0000-0000000000b1')->>'hasRecipe')::boolean) is false,
  'produto sem ficha técnica tem CMV zero e é sinalizado como tal');

select test.assert(
  ((public.product_margin('99999999-9999-9999-9999-999999999999')->>'hasRecipe')::boolean) is false,
  'produto inexistente não quebra o cálculo de margem');

-- Custo do insumo sobe: o CMV acompanha sem recadastrar a ficha.
update public.ingredients set average_cost = 0.0600 where id = 'b0000000-0000-0000-0000-000000000001';
select test.assert(
  public.product_cmv('20000000-0000-0000-0000-000000000001') = 13.00,
  'CMV acompanha a variação do custo médio do insumo');
update public.ingredients set average_cost = 0.0450 where id = 'b0000000-0000-0000-0000-000000000001';

-- Restrições.
select test.assert_denied(
  $$insert into public.product_recipes (tenant_id, product_id, ingredient_id, quantity)
    values ('10000000-0000-0000-0000-000000000001',
            '20000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002', 2)$$,
  'insumo repetido na mesma ficha técnica é rejeitado');

select test.assert_denied(
  $$insert into public.product_recipes (tenant_id, product_id, ingredient_id, quantity)
    values ('10000000-0000-0000-0000-000000000001',
            '20000000-0000-0000-0000-0000000000b1', 'b0000000-0000-0000-0000-000000000001', 0)$$,
  'quantidade zero na ficha técnica é rejeitada');

select test.assert_denied(
  $$insert into public.product_recipes (tenant_id, product_id, ingredient_id, quantity, waste_percent)
    values ('10000000-0000-0000-0000-000000000001',
            '20000000-0000-0000-0000-0000000000b1', 'b0000000-0000-0000-0000-000000000001', 10, 100)$$,
  'perda de 100% é rejeitada (divisão por zero)');

select test.assert_denied(
  $$insert into public.product_recipes (tenant_id, product_id, ingredient_id, quantity)
    values ('10000000-0000-0000-0000-000000000001',
            '20000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000001', 10)$$,
  'ficha técnica cruzando produto e insumo de tenants diferentes é rejeitada');

select test.assert_denied(
  $$delete from public.ingredients where id = 'b0000000-0000-0000-0000-000000000001'$$,
  'insumo usado em ficha técnica não pode ser apagado');

-- ------------------------------------ RLS ------------------------------------
select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
set role anon;
select test.assert((select count(*) from public.product_recipes) = 0,
  'ficha técnica não é pública');
reset role;
