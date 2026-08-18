-- =============================================================================
-- Asserções de RBAC: resolução de permissões, validação de papéis e auditoria.
-- =============================================================================
\set ON_ERROR_STOP on

select test.assert(
  (select count(*) from public.permission_catalog) >= 19,
  'catálogo de permissões é semeado');

-- --------------------------- resolução de permissões -------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);

-- O funcionário do seed é 'owner', com curinga global.
select test.assert(public.has_permission('cash.close'), 'curinga global concede qualquer permissão');
select test.assert(public.has_permission('inventory.write'), 'owner tem escrita de estoque');

-- Papel customizado com curinga de módulo e negação explícita.
insert into public.roles (id, tenant_id, key, name, permissions) values
  ('f0000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
   'garcom_junior', 'Garçom júnior',
   '{"orders.*": true, "orders.cancel": false, "tables.read": true}'::jsonb);

update public.users set role_id = 'f0000000-0000-0000-0000-000000000001'
  where id = '00000000-0000-0000-0000-0000000000a1';

select test.assert(public.has_permission('orders.create'), 'curinga de módulo concede a permissão');
select test.assert(
  public.has_permission('orders.cancel') is false,
  'negação explícita vence o curinga do módulo');
select test.assert(
  public.has_permission('tables.write') is false,
  'permissão fora do papel é negada');
select test.assert(
  public.has_permission('inventory.read') is false,
  'módulo não concedido é negado');

-- Funcionário inativo perde tudo.
update public.users set is_active = false where id = '00000000-0000-0000-0000-0000000000a1';
select test.assert(
  public.has_permission('orders.create') is false,
  'funcionário inativo não tem permissão alguma');
update public.users set is_active = true where id = '00000000-0000-0000-0000-0000000000a1';

-- ------------------------- validação do catálogo -----------------------------
select test.assert_denied(
  $$insert into public.roles (tenant_id, key, name, permissions)
    values ('10000000-0000-0000-0000-000000000001', 'invalido', 'Inválido',
            '{"pedidos.criar": true}'::jsonb)$$,
  'papel com permissão fora do catálogo é rejeitado');

select test.assert_denied(
  $$update public.roles set permissions = '{"orders.inventado": true}'::jsonb
    where id = 'f0000000-0000-0000-0000-000000000001'$$,
  'atualização com permissão desconhecida é rejeitada');

insert into public.roles (tenant_id, key, name, permissions)
values ('10000000-0000-0000-0000-000000000001', 'so_leitura', 'Somente leitura',
        '{"orders.read": true, "reports.read": true}'::jsonb);
select test.assert(
  (select count(*) from public.roles where tenant_id = '10000000-0000-0000-0000-000000000001') = 2,
  'papel com permissões válidas é aceito');

-- --------------------------------- auditoria ---------------------------------
select test.assert(
  (select count(*) from public.staff_audit_log
   where target_id = '00000000-0000-0000-0000-0000000000a1' and action = 'role_changed') = 1,
  'troca de papel é registrada na auditoria');

-- Este é o segundo ciclo de desativação do teste (o primeiro foi na checagem
-- de permissão de funcionário inativo), então a auditoria acumula duas.
update public.users set is_active = false where id = '00000000-0000-0000-0000-0000000000a1';
select test.assert(
  (select count(*) from public.staff_audit_log
   where target_id = '00000000-0000-0000-0000-0000000000a1' and action = 'deactivated') = 2,
  'cada desativação é registrada na auditoria');
update public.users set is_active = true where id = '00000000-0000-0000-0000-0000000000a1';
select test.assert(
  (select count(*) from public.staff_audit_log
   where target_id = '00000000-0000-0000-0000-0000000000a1' and action = 'reactivated') = 2,
  'cada reativação é registrada na auditoria');

-- Devolve o papel original para não afetar os testes seguintes.
update public.users set role_id = (select id from public.roles where tenant_id is null and key = 'owner')
  where id = '00000000-0000-0000-0000-0000000000a1';

-- ------------------------------------ RLS ------------------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","app_metadata":{}}', false);
set role authenticated;
select test.assert(
  public.has_permission('orders.read') is false,
  'cliente B2C não tem permissão de funcionário');
select test.assert(
  (select count(*) from public.staff_audit_log) = 0,
  'cliente não vê a auditoria de equipe');
reset role;

select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
