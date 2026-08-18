-- =============================================================================
-- Migration: Cardápio — categorias, grupos de opcionais e opções
-- Fase 2 / PBI (issue #7) — Cardápio Digital e Delivery B2C
--
-- Estende o catálogo do PBI 1 sem alterar migrations já mescladas.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- categories: seções do cardápio (Lanches, Bebidas, Sobremesas...).
-- -----------------------------------------------------------------------------
create table public.categories (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  name        text not null constraint categories_name_len check (char_length(name) between 1 and 80),
  description text,
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint categories_tenant_name_unique unique (tenant_id, name)
);

create index categories_menu_idx on public.categories (tenant_id, sort_order) where is_active;

create trigger categories_set_updated_at
  before update on public.categories
  for each row execute function public.set_updated_at();

-- Produtos passam a pertencer a uma categoria (nulo = "sem categoria").
alter table public.products
  add column category_id uuid references public.categories (id) on delete set null;

create index products_category_idx on public.products (category_id) where category_id is not null;

-- -----------------------------------------------------------------------------
-- product_option_groups: "Escolha o ponto da carne", "Adicionais"...
-- selection_type controla a UI e a validação do carrinho.
-- -----------------------------------------------------------------------------
create type public.option_selection_type as enum ('single', 'multiple');

create table public.product_option_groups (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants (id) on delete cascade,
  product_id     uuid not null references public.products (id) on delete cascade,
  name           text not null constraint option_groups_name_len check (char_length(name) between 1 and 80),
  selection_type public.option_selection_type not null default 'single',
  min_select     integer not null default 0 constraint option_groups_min_non_negative check (min_select >= 0),
  max_select     integer not null default 1 constraint option_groups_max_positive check (max_select >= 1),
  sort_order     integer not null default 0,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint option_groups_min_lte_max check (min_select <= max_select),
  -- 'single' não pode permitir mais de uma escolha.
  constraint option_groups_single_max_one check (selection_type <> 'single' or max_select = 1)
);

create index option_groups_product_idx on public.product_option_groups (product_id, sort_order);

create trigger product_option_groups_set_updated_at
  before update on public.product_option_groups
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- product_options: cada escolha, com acréscimo de preço.
-- -----------------------------------------------------------------------------
create table public.product_options (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  group_id      uuid not null references public.product_option_groups (id) on delete cascade,
  name          text not null constraint options_name_len check (char_length(name) between 1 and 80),
  price_delta   numeric(12,2) not null default 0,
  is_available  boolean not null default true,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index product_options_group_idx on public.product_options (group_id, sort_order);

create trigger product_options_set_updated_at
  before update on public.product_options
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Integridade da denormalização: tenant_id derivado do pai (mesmo padrão do
-- PBI 1 em sync_address_tenant / sync_order_item_tenant).
-- Contrato: triggers BEFORE INSERT/UPDATE, sem parâmetros externos.
-- -----------------------------------------------------------------------------
create or replace function public.sync_option_group_tenant()
returns trigger language plpgsql set search_path = '' as $$
begin
  select p.tenant_id into strict new.tenant_id
  from public.products p where p.id = new.product_id;
  return new;
end;
$$;

create trigger option_groups_sync_tenant
  before insert or update of product_id on public.product_option_groups
  for each row execute function public.sync_option_group_tenant();

create or replace function public.sync_option_tenant()
returns trigger language plpgsql set search_path = '' as $$
begin
  select g.tenant_id into strict new.tenant_id
  from public.product_option_groups g where g.id = new.group_id;
  return new;
end;
$$;

create trigger product_options_sync_tenant
  before insert or update of group_id on public.product_options
  for each row execute function public.sync_option_tenant();

-- -----------------------------------------------------------------------------
-- Snapshot dos opcionais escolhidos no item do pedido (imutável, como
-- product_name/unit_price no PBI 1).
-- -----------------------------------------------------------------------------
alter table public.order_items
  add column selected_options jsonb not null default '[]'::jsonb;

-- -----------------------------------------------------------------------------
-- RLS: leitura pública do cardápio (anon), escrita apenas pelo staff do tenant.
-- Mesmo padrão do PBI 1 — auth em subselect para cache de initplan.
-- -----------------------------------------------------------------------------
alter table public.categories            enable row level security;
alter table public.product_option_groups enable row level security;
alter table public.product_options       enable row level security;

create policy categories_select on public.categories
  for select to anon, authenticated
  using (is_active or tenant_id = (select public.current_tenant_id()));

create policy categories_staff_insert on public.categories
  for insert to authenticated
  with check (tenant_id = (select public.current_tenant_id()));

create policy categories_staff_update on public.categories
  for update to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

create policy categories_staff_delete on public.categories
  for delete to authenticated
  using (tenant_id = (select public.current_tenant_id()));

create policy option_groups_select on public.product_option_groups
  for select to anon, authenticated
  using (is_active or tenant_id = (select public.current_tenant_id()));

create policy option_groups_staff_write on public.product_option_groups
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

create policy options_select on public.product_options
  for select to anon, authenticated
  using (true);

create policy options_staff_write on public.product_options
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));
