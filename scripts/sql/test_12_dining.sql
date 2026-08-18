-- =============================================================================
-- Asserções do salão: setores, mesas e transições de status.
-- =============================================================================
\set ON_ERROR_STOP on

insert into public.dining_sectors (id, tenant_id, name, sort_order) values
  ('d0000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Interno', 1),
  ('d0000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Varanda', 2),
  ('d0000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', 'Balcão', 1);

insert into public.dining_tables (id, tenant_id, sector_id, label, seats) values
  ('e0000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000001', 'M1', 4),
  ('e0000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000002', 'V1', 2);

select test.assert(
  (select status from public.dining_tables where id = 'e0000000-0000-0000-0000-000000000001') = 'free',
  'mesa nasce livre');

select test.assert_denied(
  $$insert into public.dining_tables (tenant_id, label, seats)
    values ('10000000-0000-0000-0000-000000000001', 'M1', 2)$$,
  'mesa com identificação repetida no mesmo salão é rejeitada');

select test.assert_denied(
  $$insert into public.dining_tables (tenant_id, sector_id, label)
    values ('10000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000003', 'M9')$$,
  'mesa em setor de outro estabelecimento é rejeitada');

select test.assert_denied(
  $$insert into public.dining_tables (tenant_id, label, seats)
    values ('10000000-0000-0000-0000-000000000001', 'M9', 0)$$,
  'mesa com zero lugares é rejeitada');

select test.assert_denied(
  $$insert into public.dining_tables (tenant_id, label, map_x)
    values ('10000000-0000-0000-0000-000000000001', 'M9', 150)$$,
  'posição fora do mapa (0 a 100) é rejeitada');

-- ------------------------------- transições ---------------------------------
select test.assert(public.can_transition_table('free', 'occupied'), 'livre pode ser ocupada');
select test.assert(public.can_transition_table('occupied', 'billing'), 'ocupada pode fechar conta');
select test.assert(public.can_transition_table('billing', 'cleaning'), 'fechando conta vai para limpeza');
select test.assert(public.can_transition_table('cleaning', 'free'), 'limpeza libera a mesa');
select test.assert(
  public.can_transition_table('occupied', 'free') is false,
  'ocupada não volta direto para livre sem passar por limpeza');
select test.assert(
  public.can_transition_table('free', 'billing') is false,
  'mesa livre não fecha conta');
select test.assert(
  public.can_transition_table('occupied', 'inactive'),
  'mesa pode entrar em manutenção a qualquer momento');

update public.dining_tables set status = 'occupied' where id = 'e0000000-0000-0000-0000-000000000001';
select test.assert_denied(
  $$update public.dining_tables set status = 'free'
    where id = 'e0000000-0000-0000-0000-000000000001'$$,
  'guard rejeita salto de ocupada para livre');

update public.dining_tables set status = 'billing' where id = 'e0000000-0000-0000-0000-000000000001';
update public.dining_tables set status = 'cleaning' where id = 'e0000000-0000-0000-0000-000000000001';
update public.dining_tables set status = 'free' where id = 'e0000000-0000-0000-0000-000000000001';
select test.assert(
  (select status from public.dining_tables where id = 'e0000000-0000-0000-0000-000000000001') = 'free',
  'ciclo completo da mesa é aceito');

-- ------------------------------------ RLS ------------------------------------
select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
set role anon;
select test.assert((select count(*) from public.dining_tables) = 0, 'anônimo não vê o mapa do salão');
reset role;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);
set role authenticated;
select test.assert((select count(*) from public.dining_tables) = 2, 'staff vê as mesas do próprio salão');
select test.assert((select count(*) from public.dining_sectors) = 2, 'staff vê os setores do próprio salão');
reset role;

-- Papéis de sistema receberam as permissões de salão.
select test.assert(
  (select permissions ? 'tables.write' from public.roles where tenant_id is null and key = 'waiter'),
  'garçom recebe permissão de escrita no salão');
select test.assert(
  (select (permissions ->> 'tables.write') is null from public.roles where tenant_id is null and key = 'kitchen'),
  'cozinha não recebe escrita no salão');

select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
