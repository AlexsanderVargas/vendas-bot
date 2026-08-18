-- =============================================================================
-- Asserções do PBI 1: integridade, regras de negócio e isolamento por RLS.
-- Qualquer asserção falsa aborta o script (exit code != 0) — apto para CI.
-- =============================================================================
\set ON_ERROR_STOP on

create schema if not exists test;

-- Contrato: (ok boolean, name text) -> void. Lança exceção quando ok é falso.
create or replace function test.assert(ok boolean, name text)
returns void language plpgsql as $$
begin
  if ok is not true then
    raise exception 'FALHOU: %', name;
  end if;
  raise notice 'ok - %', name;
end;
$$;

-- Contrato: (sql text, name text) -> void. Passa quando o comando é REJEITADO.
create or replace function test.assert_denied(stmt text, name text)
returns void language plpgsql as $$
begin
  begin
    execute stmt;
  exception
    when insufficient_privilege or check_violation or foreign_key_violation
      or unique_violation or raise_exception then
      raise notice 'ok - % (bloqueado: %)', name, sqlerrm;
      return;
  end;
  raise exception 'FALHOU: % — comando deveria ter sido bloqueado', name;
end;
$$;

-- Os papéis de aplicação precisam enxergar os helpers de asserção.
grant usage on schema test to anon, authenticated;
grant execute on all functions in schema test to anon, authenticated;

-- ============================ seed ==========================================
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'staff1@t1.com'),
  ('00000000-0000-0000-0000-0000000000c1', 'clientea@gmail.com'),
  ('00000000-0000-0000-0000-0000000000c2', 'clienteb@gmail.com');

insert into public.tenants (id, slug, name, location, is_active) values
  ('10000000-0000-0000-0000-000000000001', 'lancheria-t1', 'Lancheria T1',
   extensions.ST_SetSRID(extensions.ST_MakePoint(-51.2177, -30.0346), 4326)::extensions.geography, true),
  ('10000000-0000-0000-0000-000000000002', 'bar-t2', 'Bar T2', null, true);

insert into public.users (id, tenant_id, role_id, name)
select '00000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000001', r.id, 'Staff T1'
from public.roles r where r.tenant_id is null and r.key = 'owner';

insert into public.products (id, tenant_id, name, price, is_active) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'X-Salada', 25.90, true),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Inativo', 10.00, false),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', 'Chopp', 12.00, true);

insert into public.customers (id, tenant_id, auth_user_id, name, whatsapp) values
  ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c1', 'Cliente A', '+5551999990001'),
  ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c2', 'Cliente B', '+5551999990002');

-- tenant_id proposital ERRADO: o trigger deve derivá-lo do customer.
insert into public.customer_addresses (id, customer_id, tenant_id, street, number, neighborhood, city, state, location) values
  ('40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000002', 'Rua A', '100', 'Centro', 'Porto Alegre', 'RS',
   extensions.ST_SetSRID(extensions.ST_MakePoint(-51.2100, -30.0300), 4326)::extensions.geography);

-- ==================== integridade e regras de negócio =======================
select test.assert(
  (select tenant_id from public.customer_addresses where id = '40000000-0000-0000-0000-000000000001')
    = '10000000-0000-0000-0000-000000000001',
  'trigger sync_address_tenant deriva tenant_id do cliente');

insert into public.orders (id, tenant_id, customer_id, channel, delivery_address, subtotal, delivery_fee, total) values
  ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000001', 'delivery', '{"street":"Rua A","number":"100"}', 25.90, 8.00, 33.90);
insert into public.orders (id, tenant_id, customer_id, channel, subtotal, total) values
  ('50000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000001', 'takeaway', 25.90, 25.90);
insert into public.orders (id, tenant_id, channel, subtotal, total) values
  ('50000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', 'dine_in', 12.00, 12.00);

select test.assert(
  (select array_agg(order_number order by order_number) from public.orders
     where tenant_id = '10000000-0000-0000-0000-000000000001') = array[1,2]::bigint[]
  and (select order_number from public.orders where id = '50000000-0000-0000-0000-000000000003') = 1,
  'numeração de pedidos é sequencial por tenant');

select test.assert(
  (select placed_at is not null from public.orders where id = '50000000-0000-0000-0000-000000000001'),
  'placed_at preenchido para pedido não-rascunho');

insert into public.order_items (order_id, tenant_id, product_id, product_name, unit_price, quantity) values
  ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002',
   '20000000-0000-0000-0000-000000000001', 'X-Salada', 25.90, 2);

select test.assert(
  (select bool_and(tenant_id = '10000000-0000-0000-0000-000000000001' and total = 51.80)
     from public.order_items where order_id = '50000000-0000-0000-0000-000000000001'),
  'item herda tenant do pedido e calcula total (coluna gerada)');

select test.assert_denied(
  $$insert into public.orders (tenant_id, channel, subtotal, discount, delivery_fee, total)
    values ('10000000-0000-0000-0000-000000000001', 'takeaway', 10, 0, 0, 99)$$,
  'total inconsistente é rejeitado');

select test.assert_denied(
  $$insert into public.orders (tenant_id, channel, subtotal, total)
    values ('10000000-0000-0000-0000-000000000001', 'delivery', 10, 10)$$,
  'delivery sem endereço é rejeitado');

select test.assert_denied(
  $$update public.customers set whatsapp = '51 99999-0001'
    where id = '30000000-0000-0000-0000-000000000001'$$,
  'whatsapp fora do formato E.164 é rejeitado');

select test.assert_denied(
  $$insert into public.order_items (order_id, tenant_id, product_name, unit_price, quantity)
    values ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Zero', 10, 0)$$,
  'item com quantidade zero é rejeitado');

select test.assert(
  (select extensions.ST_Distance(t.location, a.location) between 500 and 2000
     from public.tenants t, public.customer_addresses a
     where t.id = '10000000-0000-0000-0000-000000000001'
       and a.id = '40000000-0000-0000-0000-000000000001'),
  'PostGIS calcula distância tenant -> endereço em metros');

-- ======================= RLS: cliente B2C ===================================
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","app_metadata":{}}', false);
set role authenticated;

select test.assert((select count(*) from public.orders) = 2, 'cliente vê apenas os próprios pedidos');
select test.assert((select count(*) from public.order_items) = 1, 'cliente vê apenas os próprios itens');
select test.assert((select count(*) from public.products) = 2, 'cliente vê apenas produtos ativos');
select test.assert((select count(*) from public.users) = 0, 'cliente não enxerga funcionários');
select test.assert((select count(*) from public.customers) = 1, 'cliente vê apenas o próprio cadastro');

update public.customers set name = 'Cliente A Silva' where id = '30000000-0000-0000-0000-000000000001';
select test.assert(
  (select name from public.customers where id = '30000000-0000-0000-0000-000000000001') = 'Cliente A Silva',
  'cliente atualiza o próprio nome');

select test.assert_denied(
  $$update public.customers set loyalty_points = 999999
    where id = '30000000-0000-0000-0000-000000000001'$$,
  'cliente não altera loyalty_points (grant de coluna)');

select test.assert_denied(
  $$insert into public.orders (tenant_id, customer_id, channel, subtotal, total)
    values ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', 'takeaway', 5, 5)$$,
  'cliente não cria pedido em nome de outro cliente');

select test.assert_denied(
  $$select public.next_order_number('10000000-0000-0000-0000-000000000001')$$,
  'next_order_number não é executável pelo cliente');

-- RLS sem políticas não gera erro na leitura: filtra tudo. Escrita é bloqueada.
select test.assert(
  (select count(*) from public.tenant_counters) = 0,
  'tenant_counters não expõe linha alguma fora do service_role');

select test.assert_denied(
  $$insert into public.tenant_counters (tenant_id, key, value)
    values ('10000000-0000-0000-0000-000000000001', 'hack', 999)$$,
  'tenant_counters não aceita escrita fora do service_role');

insert into public.orders (id, tenant_id, customer_id, channel, status, subtotal, total)
values ('50000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001',
        '30000000-0000-0000-0000-000000000001', 'takeaway', 'placed', 0, 0);
select test.assert((select count(*) from public.orders) = 3, 'cliente cria pedido próprio');

reset role;

-- ======================= RLS: outro cliente =================================
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', false);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c2","app_metadata":{}}', false);
set role authenticated;
select test.assert((select count(*) from public.orders) = 0, 'cliente B não vê pedidos do cliente A');
select test.assert((select count(*) from public.customer_addresses) = 0, 'cliente B não vê endereços do cliente A');
reset role;

-- ======================= RLS: funcionário ===================================
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);
set role authenticated;

select test.assert((select count(*) from public.orders) = 3, 'staff vê os pedidos do próprio tenant');
select test.assert(
  (select count(*) from public.orders where tenant_id = '10000000-0000-0000-0000-000000000002') = 0,
  'staff não vê pedidos de outro tenant');
select test.assert((select count(*) from public.customers) = 2, 'staff vê os clientes do tenant');
select test.assert(
  public.is_staff_of('10000000-0000-0000-0000-000000000001')
  and not public.is_staff_of('10000000-0000-0000-0000-000000000002'),
  'is_staff_of distingue o tenant do funcionário');

-- O fluxo válido é placed -> confirmed -> preparing (ver can_transition_order).
update public.orders set status = 'confirmed' where id = '50000000-0000-0000-0000-000000000001';
update public.orders set status = 'preparing' where id = '50000000-0000-0000-0000-000000000001';
select test.assert(
  (select status from public.orders where id = '50000000-0000-0000-0000-000000000001') = 'preparing',
  'staff avança o status do pedido (fluxo KDS)');

select test.assert_denied(
  $$update public.orders set status = 'delivered'
    where id = '50000000-0000-0000-0000-000000000002'$$,
  'salto de status inválido é rejeitado pelo guard');

select test.assert_denied(
  $$insert into public.products (tenant_id, name, price)
    values ('10000000-0000-0000-0000-000000000002', 'Invasor', 1)$$,
  'staff não cria produto em tenant alheio');

-- UPDATE cross-tenant não gera erro: o USING da RLS filtra a linha e o
-- comando vira no-op. O que importa é que o dado alheio permaneça intacto.
update public.orders set status = 'completed'
  where id = '50000000-0000-0000-0000-000000000003';
reset role;

select test.assert(
  (select status from public.orders where id = '50000000-0000-0000-0000-000000000003') = 'placed',
  'update cross-tenant não altera o pedido do outro tenant');

-- ======================= RLS: anônimo =======================================
select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
set role anon;
select test.assert((select count(*) from public.tenants) = 2, 'anônimo vê tenants ativos (cardápio público)');
select test.assert((select count(*) from public.products) = 2, 'anônimo vê apenas produtos ativos');
select test.assert((select count(*) from public.orders) = 0, 'anônimo não vê pedidos');
select test.assert((select count(*) from public.customers) = 0, 'anônimo não vê clientes');
reset role;
