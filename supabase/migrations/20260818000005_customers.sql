-- =============================================================================
-- Migration: B2C — customers, customer_addresses
-- PBI 1 (issue #2) — Database Core & B2C
--
-- Modelo: a base de clientes é POR TENANT. Um mesmo usuário do Supabase Auth
-- (login social Google/Facebook/Outlook) pode ser cliente de vários
-- restaurantes — uma linha em customers por tenant.
-- Cadastro progressivo: após o social login, apenas o WhatsApp é solicitado
-- para concluir o perfil (whatsapp nullable até a conclusão).
-- =============================================================================

create table public.customers (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants (id) on delete cascade,
  auth_user_id         uuid not null references auth.users (id) on delete cascade,
  name                 text,
  whatsapp             text
                       constraint customers_whatsapp_e164 check (whatsapp is null or whatsapp ~ '^\+[1-9][0-9]{7,14}$'),
  whatsapp_verified_at timestamptz,
  loyalty_points       integer not null default 0
                       constraint customers_loyalty_non_negative check (loyalty_points >= 0),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint customers_tenant_auth_unique unique (tenant_id, auth_user_id)
);

-- Lookup reverso: "todas as contas de cliente deste usuário" (painel do cliente).
create index customers_auth_user_idx on public.customers (auth_user_id);

create trigger customers_set_updated_at
  before update on public.customers
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- customer_addresses: múltiplos endereços por cliente.
-- location (PostGIS) permite taxa de entrega por distância:
--   ST_Distance(tenant.location, address.location) -> metros (geography).
-- tenant_id denormalizado torna a política RLS de staff barata (sem join).
-- -----------------------------------------------------------------------------
create table public.customer_addresses (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references public.customers (id) on delete cascade,
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  label        text not null default 'Casa' constraint addresses_label_len check (char_length(label) between 1 and 40),
  street       text not null,
  number       text not null,
  complement   text,
  neighborhood text not null,
  city         text not null,
  state        char(2) not null,
  zip_code     text constraint addresses_zip_format check (zip_code is null or zip_code ~ '^[0-9]{8}$'),
  reference    text,
  location     extensions.geography(point, 4326),
  is_default   boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index customer_addresses_customer_idx on public.customer_addresses (customer_id);
create index customer_addresses_tenant_idx on public.customer_addresses (tenant_id);
create index customer_addresses_location_gist on public.customer_addresses using gist (location);

-- No máximo 1 endereço padrão por cliente.
create unique index customer_addresses_one_default
  on public.customer_addresses (customer_id)
  where is_default;

create trigger customer_addresses_set_updated_at
  before update on public.customer_addresses
  for each row execute function public.set_updated_at();
