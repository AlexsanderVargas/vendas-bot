-- =============================================================================
-- Migration: Catálogo — products
-- PBI 1 (issue #2) — Database Core & B2C
--
-- Nota de escopo: ficha técnica, insumos e estoque/lotes chegam na Feature
-- "Produtos & Insumos". A coluna cost já existe aqui para ancorar o CMV.
-- =============================================================================

create table public.products (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  sku          text constraint products_sku_len check (sku is null or char_length(sku) between 1 and 40),
  name         text not null constraint products_name_len check (char_length(name) between 1 and 120),
  description  text,
  price        numeric(12,2) not null constraint products_price_positive check (price >= 0),
  cost         numeric(12,2) constraint products_cost_positive check (cost is null or cost >= 0),
  image_url    text,
  is_active    boolean not null default true,  -- false = removido do cardápio (soft delete)
  is_available boolean not null default true,  -- false = esgotado (exibido como indisponível)
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint products_tenant_sku_unique unique (tenant_id, sku)
);

-- Listagem do cardápio público: só produtos ativos, na ordem definida.
create index products_menu_idx on public.products (tenant_id, sort_order)
  where is_active;

-- Busca fuzzy por nome dentro do tenant (pg_trgm).
create index products_name_trgm on public.products
  using gin (name extensions.gin_trgm_ops);

create trigger products_set_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();
