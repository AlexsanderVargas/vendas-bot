-- =============================================================================
-- Escalada de privilégio no cadastro de equipe (migration 20260819000038).
--
-- Reproduz o ataque que a migration fecha: um funcionário de Cozinha, com o
-- próprio token e falando direto com o PostgREST, se promovia a Proprietário.
-- Cada asserção aqui é uma porta que precisa continuar fechada.
-- =============================================================================
\set ON_ERROR_STOP on
\set t1 '10000000-0000-0000-0000-000000000001'
\set t2 '10000000-0000-0000-0000-000000000002'
\set cozinha '00000000-0000-0000-0000-0000000000a2'
\set dono '00000000-0000-0000-0000-0000000000a1'

insert into auth.users (id, email) values (:'cozinha', 'cozinha@t1.com')
on conflict (id) do nothing;

insert into public.users (id, tenant_id, role_id, name)
select :'cozinha', :'t1', r.id, 'Cozinheiro'
from public.roles r where r.tenant_id is null and r.key = 'kitchen'
on conflict (id) do nothing;

-- --------------------------------------------------------------------------
-- 1. O ataque, com o token do funcionário de menor privilégio do sistema.
-- --------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', :'cozinha', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated",
    "app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);
set role authenticated;

select test.assert_denied(
  $$ update public.users
       set role_id = (select id from public.roles where tenant_id is null and key = 'owner')
     where id = '00000000-0000-0000-0000-0000000000a2' $$,
  'funcionário não promove a si mesmo a Proprietário');

select test.assert_denied(
  $$ insert into public.roles (tenant_id, key, name, permissions)
     values ('10000000-0000-0000-0000-000000000001', 'onipotente', 'Onipotente',
             '{"*": true}'::jsonb) $$,
  'funcionário não cria papel com curinga total');

select test.assert_denied(
  $$ update public.roles set permissions = '{"*": true}'::jsonb
     where tenant_id is null and key = 'kitchen' $$,
  'funcionário não reescreve as permissões de um papel de sistema');

select test.assert_denied(
  $$ update public.users set is_active = false
     where id = '00000000-0000-0000-0000-0000000000a1' $$,
  'funcionário não desativa o dono do estabelecimento');

select test.assert_denied(
  $$ delete from public.users where id = '00000000-0000-0000-0000-0000000000a1' $$,
  'funcionário não remove colega do cadastro');

-- --------------------------------------------------------------------------
-- 2. O que continua funcionando: o próprio cadastro operacional.
-- --------------------------------------------------------------------------
update public.users set name = 'Chef de Cozinha', phone = '+5551999990010'
  where id = :'cozinha';

select test.assert(
  (select name from public.users where id = :'cozinha') = 'Chef de Cozinha',
  'funcionário edita o próprio nome e telefone');

-- A policy recorta por linha: o UPDATE não falha, simplesmente não alcança
-- ninguém. Por isso a asserção olha o resultado, não o erro.
update public.users set name = 'Invadido' where id = :'dono';

select test.assert(
  (select name from public.users where id = :'dono') <> 'Invadido',
  'edição do próprio cadastro não alcança a linha de outro funcionário');

-- --------------------------------------------------------------------------
-- 3. Defesa em profundidade: se um GRANT for afrouxado por engano no futuro,
--    o trigger ainda barra. Simula exatamente esse engano.
-- --------------------------------------------------------------------------
reset role;
grant update (role_id, is_active) on table public.users to authenticated;
set role authenticated;

select test.assert_denied(
  $$ update public.users
       set role_id = (select id from public.roles where tenant_id is null and key = 'owner')
     where id = '00000000-0000-0000-0000-0000000000a2' $$,
  'trigger barra a autopromoção mesmo com o GRANT de coluna afrouxado');

reset role;
revoke update (role_id, is_active) on table public.users from authenticated;

-- --------------------------------------------------------------------------
-- 4. O backend (service_role) mantém o caminho legítimo — e mesmo ele não
--    move um funcionário de estabelecimento.
-- --------------------------------------------------------------------------
-- Os helpers de asserção nasceram visíveis para anon e authenticated apenas.
grant usage on schema test to service_role;
grant execute on all functions in schema test to service_role;

select set_config('request.jwt.claims', '{"role":"service_role"}', false);
select set_config('request.jwt.claim.sub', '', false);
set role service_role;

select test.assert_denied(
  $$ update public.users set tenant_id = '10000000-0000-0000-0000-000000000002'
     where id = '00000000-0000-0000-0000-0000000000a2' $$,
  'vínculo de estabelecimento é imutável até para o backend');

update public.users
  set role_id = (select id from public.roles where tenant_id is null and key = 'waiter')
  where id = :'cozinha';

select test.assert(
  (select r.key from public.users u join public.roles r on r.id = u.role_id
    where u.id = :'cozinha') = 'waiter',
  'backend promove funcionário depois de conferir a permissão (caminho legítimo)');

reset role;
select set_config('request.jwt.claims', '{}', false);
select set_config('request.jwt.claim.sub', '', false);
