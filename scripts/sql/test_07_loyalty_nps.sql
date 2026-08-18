-- =============================================================================
-- Asserções de fidelidade (pontos/cashback) e avaliação NPS.
-- =============================================================================
\set ON_ERROR_STOP on

update public.tenants set
  loyalty_enabled = true,
  loyalty_points_per_currency = 1,
  loyalty_cashback_percent = 5
where id = '10000000-0000-0000-0000-000000000001';

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","app_metadata":{}}', false);

create temporary table t_fid as
select ((public.checkout_order(
  '10000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  'takeaway',
  jsonb_build_array(jsonb_build_object(
    'productId', '20000000-0000-0000-0000-0000000000b1', 'quantity', 10))  -- 10 x 7,00 = 70,00
))->'order'->>'id')::uuid as id;

create temporary table t_saldo as
select loyalty_points as antes from public.customers
where id = '30000000-0000-0000-0000-000000000001';

-- Fluxo do estabelecimento até a entrega.
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);

select public.advance_order_status((select id from t_fid), 'confirmed');
select public.advance_order_status((select id from t_fid), 'preparing');
select public.advance_order_status((select id from t_fid), 'ready');

select test.assert(
  (select count(*) from public.loyalty_transactions l, t_fid f where l.order_id = f.id) = 0,
  'pontos não são creditados antes da conclusão do pedido');

select public.advance_order_status((select id from t_fid), 'completed');

select test.assert(
  (select points from public.loyalty_transactions l, t_fid f where l.order_id = f.id) = 70,
  'pontos creditados sobre o subtotal (1 ponto por real)');

select test.assert(
  (select cashback from public.loyalty_transactions l, t_fid f where l.order_id = f.id) = 3.50,
  'cashback de 5% é calculado sobre o subtotal');

select test.assert(
  (select loyalty_points from public.customers where id = '30000000-0000-0000-0000-000000000001')
    = (select antes from t_saldo) + 70,
  'saldo do cliente é atualizado');

select test.assert(
  (select type from public.loyalty_transactions l, t_fid f where l.order_id = f.id) = 'earn',
  'transação é registrada como crédito');

-- ------------------------------ NPS -----------------------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","app_metadata":{}}', false);

select test.assert(
  ((select public.submit_order_review(f.id, 5::smallint, 'Chegou quentinho!') from t_fid f)->>'ok')::boolean,
  'cliente avalia o próprio pedido concluído');

select test.assert(
  (select rating from public.order_reviews r, t_fid f where r.order_id = f.id) = 5,
  'nota é gravada');

select test.assert(
  ((select public.submit_order_review(f.id, 4::smallint) from t_fid f)->>'error') = 'ja_avaliado',
  'segunda avaliação do mesmo pedido é recusada');

select test.assert_denied(
  $$insert into public.order_reviews (order_id, tenant_id, customer_id, rating)
    select f.id, '10000000-0000-0000-0000-000000000001',
           '30000000-0000-0000-0000-000000000001', 9 from t_fid f$$,
  'nota fora da escala de 1 a 5 é rejeitada');

-- Pedido ainda não concluído não pode ser avaliado.
create temporary table t_novo as
select ((public.checkout_order(
  '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'takeaway',
  jsonb_build_array(jsonb_build_object(
    'productId', '20000000-0000-0000-0000-0000000000b1', 'quantity', 1))
))->'order'->>'id')::uuid as id;

select test.assert(
  ((select public.submit_order_review(n.id, 5::smallint) from t_novo n)->>'error') = 'pedido_nao_concluido',
  'pedido em andamento não pode ser avaliado');

-- Cliente B não avalia pedido do cliente A.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', false);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c2","app_metadata":{}}', false);
select test.assert(
  ((select public.submit_order_review(f.id, 1::smallint) from t_fid f)->>'error') = 'nao_autorizado',
  'cliente não avalia pedido alheio');

-- Métricas de NPS.
select test.assert(
  (public.tenant_nps('10000000-0000-0000-0000-000000000001')->>'total')::int = 1
  and (public.tenant_nps('10000000-0000-0000-0000-000000000001')->>'promoters')::int = 1
  and (public.tenant_nps('10000000-0000-0000-0000-000000000001')->>'nps')::numeric = 100,
  'NPS considera 5 estrelas como promotor');

select test.assert(
  (public.tenant_nps('10000000-0000-0000-0000-000000000002')->>'total')::int = 0
  and (public.tenant_nps('10000000-0000-0000-0000-000000000002')->>'nps')::numeric = 0,
  'NPS de tenant sem avaliações não divide por zero');

-- RLS: o extrato de pontos é privado; a avaliação é pública.
set role authenticated;
select test.assert(
  (select count(*) from public.loyalty_transactions) = 0,
  'cliente B não vê o extrato de pontos do cliente A');
reset role;

select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
set role anon;
select test.assert((select count(*) from public.order_reviews) = 1,
  'avaliações são públicas (reputação do estabelecimento)');
select test.assert((select count(*) from public.loyalty_transactions) = 0,
  'anônimo não vê extrato de pontos');
reset role;
