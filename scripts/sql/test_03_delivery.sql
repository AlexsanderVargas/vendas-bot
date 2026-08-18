-- =============================================================================
-- Asserções da cotação de frete (quote_delivery) nos três modos.
-- =============================================================================
\set ON_ERROR_STOP on

-- Tenant 1 (Porto Alegre, -30.0346/-51.2177) passa a cobrar por distância.
update public.tenants set
  delivery_fee_mode = 'distance',
  delivery_base_fee = 5.00,
  delivery_fee_per_km = 2.00,
  delivery_max_distance_km = 8,
  delivery_min_order = 20.00,
  delivery_eta_minutes = 45
where id = '10000000-0000-0000-0000-000000000001';

-- ~1,1 km do restaurante: 5,00 + 2,00 * 1,1 ≈ 7,20
select test.assert(
  ((public.quote_delivery('10000000-0000-0000-0000-000000000001', 50.00, -30.0300, -51.2100)->>'eligible')::boolean)
  and ((public.quote_delivery('10000000-0000-0000-0000-000000000001', 50.00, -30.0300, -51.2100)->>'fee')::numeric between 6.50 and 8.00),
  'modo distância cobra base + por km');

select test.assert(
  (public.quote_delivery('10000000-0000-0000-0000-000000000001', 50.00, -30.0300, -51.2100)->>'eta_minutes')::int = 45,
  'modo distância devolve o tempo estimado do tenant');

-- Ponto a ~90 km (Caxias do Sul) fica fora do raio de 8 km.
select test.assert(
  ((public.quote_delivery('10000000-0000-0000-0000-000000000001', 50.00, -29.1678, -51.1794)->>'eligible')::boolean) is false
  and (public.quote_delivery('10000000-0000-0000-0000-000000000001', 50.00, -29.1678, -51.1794)->>'reason') = 'fora_da_area',
  'modo distância recusa endereço fora do raio máximo');

select test.assert(
  (public.quote_delivery('10000000-0000-0000-0000-000000000001', 50.00)->>'reason') = 'sem_localizacao',
  'modo distância exige coordenadas do cliente');

select test.assert(
  (public.quote_delivery('10000000-0000-0000-0000-000000000001', 10.00, -30.0300, -51.2100)->>'reason') = 'pedido_minimo'
  and (public.quote_delivery('10000000-0000-0000-0000-000000000001', 10.00, -30.0300, -51.2100)->>'min_order')::numeric = 20.00,
  'pedido abaixo do mínimo é recusado informando o mínimo exigido');

-- Frete grátis acima de 100.
update public.tenants set delivery_free_above = 100.00
  where id = '10000000-0000-0000-0000-000000000001';
select test.assert(
  (public.quote_delivery('10000000-0000-0000-0000-000000000001', 150.00, -30.0300, -51.2100)->>'fee')::numeric = 0
  and ((public.quote_delivery('10000000-0000-0000-0000-000000000001', 150.00, -30.0300, -51.2100)->>'eligible')::boolean),
  'frete grátis acima do valor configurado');

-- ---------------------------- modo por bairro -------------------------------
update public.tenants set delivery_fee_mode = 'neighborhood', delivery_free_above = null,
  delivery_min_order = 0
where id = '10000000-0000-0000-0000-000000000001';

insert into public.delivery_zones (tenant_id, neighborhood, city, fee, min_order, eta_minutes) values
  ('10000000-0000-0000-0000-000000000001', 'Centro Histórico', 'Porto Alegre', 6.00, 25.00, 30),
  ('10000000-0000-0000-0000-000000000001', 'Cidade Baixa', 'Porto Alegre', 8.50, 0, 40);

select test.assert(
  (public.quote_delivery('10000000-0000-0000-0000-000000000001', 50.00, null, null, 'Cidade Baixa', 'Porto Alegre')->>'fee')::numeric = 8.50,
  'modo bairro aplica a taxa da zona');

select test.assert(
  (public.quote_delivery('10000000-0000-0000-0000-000000000001', 50.00, null, null, 'centro historico', 'porto alegre')->>'fee')::numeric = 6.00,
  'busca de bairro ignora acento e caixa');

select test.assert(
  (public.quote_delivery('10000000-0000-0000-0000-000000000001', 10.00, null, null, 'Centro Histórico', 'Porto Alegre')->>'reason') = 'pedido_minimo',
  'pedido mínimo da zona prevalece sobre o do tenant');

select test.assert(
  (public.quote_delivery('10000000-0000-0000-0000-000000000001', 50.00, null, null, 'Ipanema', 'Porto Alegre')->>'reason') = 'bairro_nao_atendido',
  'bairro sem zona cadastrada é recusado');

select test.assert(
  (public.quote_delivery('10000000-0000-0000-0000-000000000001', 50.00, null, null, 'Cidade Baixa', 'Porto Alegre')->>'eta_minutes')::int = 40,
  'tempo estimado da zona sobrepõe o do tenant');

-- ------------------------------ modo fixo -----------------------------------
update public.tenants set delivery_fee_mode = 'fixed', delivery_base_fee = 9.90
  where id = '10000000-0000-0000-0000-000000000001';

select test.assert(
  (public.quote_delivery('10000000-0000-0000-0000-000000000001', 50.00)->>'fee')::numeric = 9.90
  and ((public.quote_delivery('10000000-0000-0000-0000-000000000001', 50.00)->>'eligible')::boolean),
  'modo fixo cobra a taxa base sem exigir localização');

select test.assert(
  (public.quote_delivery('99999999-9999-9999-9999-999999999999', 50.00)->>'reason') = 'estabelecimento_inativo',
  'tenant inexistente é recusado');

-- --------------------------- zona duplicada ---------------------------------
select test.assert_denied(
  $$insert into public.delivery_zones (tenant_id, neighborhood, city, fee)
    values ('10000000-0000-0000-0000-000000000001', 'cidade baixa', 'PORTO ALEGRE', 5.00)$$,
  'zona duplicada (mesmo bairro normalizado) é rejeitada');

-- ------------------------------ RLS -----------------------------------------
select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
set role anon;
select test.assert((select count(*) from public.delivery_zones) = 2, 'anônimo consulta as zonas ativas');
select test.assert(
  (public.quote_delivery('10000000-0000-0000-0000-000000000001', 50.00)->>'fee')::numeric = 9.90,
  'anônimo consegue cotar o frete antes de entrar');
select test.assert_denied(
  $$insert into public.delivery_zones (tenant_id, neighborhood, city, fee)
    values ('10000000-0000-0000-0000-000000000001', 'Hack', 'Porto Alegre', 0)$$,
  'anônimo não cria zona de entrega');
reset role;
