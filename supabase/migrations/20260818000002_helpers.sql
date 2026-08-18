-- =============================================================================
-- Migration: Funções auxiliares (triggers e RLS)
-- PBI 1 (issue #2) — Database Core & B2C
--
-- CONTRATOS ESTÁVEIS: as assinaturas (entrada/saída) das funções abaixo são
-- contratos públicos do schema e não podem mudar (docs/engineering-rules.md).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- set_updated_at()
-- Contrato: trigger BEFORE UPDATE em qualquer tabela com coluna updated_at.
--   Entrada: nenhuma (contexto de trigger). Saída: NEW com updated_at = now().
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- current_tenant_id()
-- Contrato: () -> uuid | null
--   Lê o claim app_metadata.tenant_id do JWT do Supabase Auth (setado pelo
--   backend via service_role no onboarding do funcionário). Retorna null para
--   usuários sem vínculo de staff (clientes B2C e anônimos).
--   STABLE: pode ser envolvida em subselect nas políticas RLS para cache de
--   initplan (avaliada 1x por statement, não por linha).
-- -----------------------------------------------------------------------------
create or replace function public.current_tenant_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid;
$$;

-- Nota: is_staff_of(uuid) depende de public.users e é criada na migration
-- 20260818000003_core_tenancy.sql, após a tabela existir.
