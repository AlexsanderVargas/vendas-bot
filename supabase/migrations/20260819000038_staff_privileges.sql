-- =============================================================================
-- Escalada de privilégio: funcionário promovendo a si mesmo (issue #74)
--
-- O RBAC era verificado APENAS na API (`requirePermission`). O banco, porém,
-- fala direto com o navegador: a URL do PostgREST e a chave anônima são
-- públicas por construção, e qualquer funcionário autenticado podia mandar
--
--     PATCH /rest/v1/users?id=eq.<o-próprio-id>  { "role_id": "<owner>" }
--
-- porque `authenticated` tinha UPDATE irrestrito em public.users e a policy
-- `users_staff_update` só exigia "mesmo estabelecimento". Um funcionário de
-- Cozinha virava Proprietário — DRE, fluxo de caixa, custo de insumo,
-- integrações e a desativação do próprio dono.
--
-- O mesmo valia por outro caminho: criar um papel `{"*": true}` no próprio
-- estabelecimento (INSERT em public.roles era liberado) e se atribuir a ele.
--
-- A correção tem três camadas, porque nenhuma delas sozinha resolve:
--   1. GRANT  — tira do papel `authenticated` o poder de escrever cadastro de
--               equipe; sobra só o que a pessoa muda no próprio registro.
--   2. POLICY — o que restou de UPDATE alcança apenas a própria linha.
--   3. TRIGGER — rede de segurança para papel, situação e vínculo, inclusive
--               se um GRANT for afrouxado por engano no futuro.
--
-- Gestão de equipe passa a ser exclusividade do backend com `service_role`,
-- que já roda depois de `requirePermission('staff.write')`.
-- =============================================================================

-- --------------------------------- 1. GRANTs ---------------------------------
-- Os privilégios padrão do Supabase concedem tudo em `public` para anon e
-- authenticated; estas duas tabelas são a exceção.
revoke insert, update, delete, truncate on table public.users from anon, authenticated;
revoke insert, update, delete, truncate on table public.roles from anon, authenticated;

-- O funcionário continua dono do próprio cadastro operacional. `role_id`,
-- `is_active` e `tenant_id` ficam de fora: são decisão de quem administra.
grant update (name, phone) on table public.users to authenticated;

-- -------------------------------- 2. POLICIES --------------------------------
drop policy if exists users_staff_update on public.users;

create policy users_self_update on public.users
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- Papéis (perfis de acesso) só nascem, mudam e somem pelo backend.
drop policy if exists roles_staff_insert on public.roles;
drop policy if exists roles_staff_update on public.roles;
drop policy if exists roles_staff_delete on public.roles;

-- -------------------------------- 3. TRIGGER ---------------------------------
-- NÃO é `security definer` de propósito: precisa enxergar o papel de banco de
-- quem chamou. Sob `security definer`, `current_user` viraria o dono da função
-- e a checagem passaria a valer para todo mundo — inclusive para o backend,
-- que legitimamente promove funcionários depois de conferir a permissão.
--
-- `authenticated` é o papel que o PostgREST assume ao atender um token de
-- usuário. `service_role` e as migrations não passam por aqui.
create or replace function public.enforce_user_privileges()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Mudar o estabelecimento de um funcionário existente reaproveitaria o
  -- histórico de auditoria de outra empresa. Vínculo novo é registro novo.
  if new.tenant_id is distinct from old.tenant_id then
    raise exception 'vínculo de estabelecimento é imutável'
      using errcode = 'insufficient_privilege';
  end if;

  if current_user = 'authenticated'
     and (new.role_id is distinct from old.role_id
          or new.is_active is distinct from old.is_active) then

    -- Promover a si mesmo nunca é legítimo, nem para quem tem staff.write:
    -- o dono do estabelecimento faz isso pelo backend, com registro na
    -- auditoria de quem promoveu quem.
    if new.id = (select auth.uid()) then
      raise exception 'não é permitido alterar o próprio papel ou a própria situação'
        using errcode = 'insufficient_privilege';
    end if;

    if not public.has_permission('staff.write') then
      raise exception 'alterar papel ou situação de funcionário requer staff.write'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$$;

create trigger users_enforce_privileges
  before update on public.users
  for each row execute function public.enforce_user_privileges();
