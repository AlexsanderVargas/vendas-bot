-- =============================================================================
-- Migration: Core de tenancy — tenants, roles, users (staff)
-- PBI 1 (issue #2) — Database Core & B2C
-- =============================================================================

-- Modo de cálculo da taxa de entrega do tenant.
create type public.delivery_fee_mode as enum ('distance', 'neighborhood', 'fixed');

-- -----------------------------------------------------------------------------
-- tenants: estabelecimentos (lancherias, restaurantes, bares).
-- location (PostGIS) alimenta: taxa por distância e rotas no modo retirada.
-- -----------------------------------------------------------------------------
create table public.tenants (
  id                uuid primary key default gen_random_uuid(),
  slug              extensions.citext not null unique
                    constraint tenants_slug_format check (slug ~ '^[a-z0-9]([a-z0-9-]{1,58}[a-z0-9])?$'),
  name              text not null constraint tenants_name_len check (char_length(name) between 1 and 120),
  document          text
                    constraint tenants_document_format check (document is null or document ~ '^[0-9]{14}$'), -- CNPJ, só dígitos
  phone             text,
  -- Endereço do estabelecimento (exibido no modo retirada/takeaway)
  address_street    text,
  address_number    text,
  address_complement text,
  neighborhood      text,
  city              text,
  state             char(2),
  zip_code          text constraint tenants_zip_format check (zip_code is null or zip_code ~ '^[0-9]{8}$'),
  location          extensions.geography(point, 4326),
  delivery_fee_mode public.delivery_fee_mode not null default 'fixed',
  settings          jsonb not null default '{}'::jsonb, -- preferências não estruturais (tema, horários, mensagens)
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index tenants_location_gist on public.tenants using gist (location);

create trigger tenants_set_updated_at
  before update on public.tenants
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- roles: papéis RBAC. tenant_id NULL = papel de sistema (seed global,
-- somente leitura para tenants); tenant_id preenchido = papel customizado.
-- permissions: mapa granular {"orders.create": true, "cash.close": false, ...}
-- -----------------------------------------------------------------------------
create table public.roles (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references public.tenants (id) on delete cascade,
  key         text not null constraint roles_key_format check (key ~ '^[a-z][a-z0-9_]{1,38}$'),
  name        text not null,
  permissions jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- PG15+: trata NULLs como iguais, garantindo unicidade também nos papéis de sistema
  constraint roles_tenant_key_unique unique nulls not distinct (tenant_id, key)
);

create index roles_tenant_idx on public.roles (tenant_id);

create trigger roles_set_updated_at
  before update on public.roles
  for each row execute function public.set_updated_at();

-- Papéis de sistema (disponíveis para todos os tenants).
insert into public.roles (tenant_id, key, name, permissions) values
  (null, 'owner',   'Proprietário', '{"*": true}'::jsonb),
  (null, 'manager', 'Gerente',      '{"orders.*": true, "products.*": true, "cash.*": true, "reports.read": true, "staff.*": true}'::jsonb),
  (null, 'cashier', 'Caixa',        '{"orders.read": true, "orders.charge": true, "cash.*": true}'::jsonb),
  (null, 'waiter',  'Garçom',       '{"orders.create": true, "orders.read": true, "tables.*": true}'::jsonb),
  (null, 'kitchen', 'Cozinha',      '{"kds.read": true, "kds.update_status": true}'::jsonb);

-- -----------------------------------------------------------------------------
-- users: funcionários (staff). 1:1 com auth.users do Supabase.
-- O backend (service_role) grava app_metadata.tenant_id no JWT no onboarding.
-- -----------------------------------------------------------------------------
create table public.users (
  id         uuid primary key references auth.users (id) on delete cascade,
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  role_id    uuid not null references public.roles (id) on delete restrict,
  name       text not null constraint users_name_len check (char_length(name) between 1 and 120),
  phone      text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index users_tenant_idx on public.users (tenant_id) include (role_id, is_active);
create index users_role_idx on public.users (role_id);

create trigger users_set_updated_at
  before update on public.users
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- is_staff_of(p_tenant_id uuid)  [helper de RLS — criada aqui pois depende de users]
-- Contrato: (uuid) -> boolean  (ESTÁVEL — ver docs/engineering-rules.md)
--   Verifica no banco (não apenas no claim JWT) se o usuário autenticado é
--   funcionário ATIVO do tenant. SECURITY DEFINER para consultar public.users
--   sem recursão de RLS. Uso: políticas granulares futuras e backend.
-- -----------------------------------------------------------------------------
create or replace function public.is_staff_of(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.users u
    where u.id = auth.uid()
      and u.tenant_id = p_tenant_id
      and u.is_active
  );
$$;
