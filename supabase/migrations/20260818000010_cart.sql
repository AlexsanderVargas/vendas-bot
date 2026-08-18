-- =============================================================================
-- Migration: Carrinho persistente e sugestões de upsell/cross-sell
-- Fase 2 / PBI (issue #9) — Cardápio Digital e Delivery B2C
--
-- O carrinho vive primeiro no localStorage (visitante anônimo). Ao entrar, é
-- sincronizado aqui para permitir reengajamento ("você deixou itens no
-- carrinho") e continuidade entre dispositivos.
-- =============================================================================

create table public.carts (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  customer_id  uuid not null references public.customers (id) on delete cascade,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- Um carrinho aberto por cliente por estabelecimento.
  constraint carts_customer_unique unique (tenant_id, customer_id)
);

create index carts_customer_idx on public.carts (customer_id);
-- Alvo das campanhas de reengajamento: carrinhos parados há X tempo.
create index carts_stale_idx on public.carts (tenant_id, updated_at desc);

create trigger carts_set_updated_at
  before update on public.carts
  for each row execute function public.set_updated_at();

create table public.cart_items (
  id               uuid primary key default gen_random_uuid(),
  cart_id          uuid not null references public.carts (id) on delete cascade,
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  product_id       uuid not null references public.products (id) on delete cascade,
  /** Identidade da linha: produto + combinação de opcionais (buildLineId no web). */
  line_key         text not null,
  quantity         numeric(10,3) not null constraint cart_items_quantity_positive check (quantity > 0),
  notes            text,
  selected_options jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint cart_items_line_unique unique (cart_id, line_key)
);

create index cart_items_cart_idx on public.cart_items (cart_id);

create trigger cart_items_set_updated_at
  before update on public.cart_items
  for each row execute function public.set_updated_at();

-- tenant_id derivado do carrinho (mesmo padrão do PBI 1).
create or replace function public.sync_cart_item_tenant()
returns trigger language plpgsql set search_path = '' as $$
begin
  select c.tenant_id into strict new.tenant_id
  from public.carts c where c.id = new.cart_id;
  return new;
end;
$$;

create trigger cart_items_sync_tenant
  before insert or update of cart_id on public.cart_items
  for each row execute function public.sync_cart_item_tenant();

-- -----------------------------------------------------------------------------
-- upsell_rules: sugestões configuradas pelo estabelecimento.
-- trigger_category_id nulo = sugerir sempre; preenchido = sugerir apenas
-- quando o carrinho tiver algum item daquela categoria ("comprou lanche,
-- ofereça bebida").
-- -----------------------------------------------------------------------------
create table public.upsell_rules (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants (id) on delete cascade,
  trigger_category_id uuid references public.categories (id) on delete cascade,
  suggested_product_id uuid not null references public.products (id) on delete cascade,
  sort_order          integer not null default 0,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint upsell_rules_unique unique nulls not distinct (tenant_id, trigger_category_id, suggested_product_id)
);

create index upsell_rules_lookup on public.upsell_rules (tenant_id, sort_order) where is_active;

create trigger upsell_rules_set_updated_at
  before update on public.upsell_rules
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- suggest_upsell(p_tenant_id uuid, p_category_ids uuid[], p_exclude_product_ids uuid[], p_limit int)
-- Contrato ESTÁVEL: -> setof (id uuid, name text, price numeric, image_url text, description text)
--   Sugestões para o carrinho atual: regras cujo gatilho é nulo ou casa com
--   uma das categorias já presentes, excluindo o que já está no carrinho.
-- -----------------------------------------------------------------------------
create or replace function public.suggest_upsell(
  p_tenant_id           uuid,
  p_category_ids        uuid[] default '{}',
  p_exclude_product_ids uuid[] default '{}',
  p_limit               integer default 3
)
returns table (id uuid, name text, price numeric, image_url text, description text)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct on (p.id) p.id, p.name, p.price, p.image_url, p.description
  from public.upsell_rules r
  join public.products p on p.id = r.suggested_product_id
  where r.tenant_id = p_tenant_id
    and r.is_active
    and p.is_active
    and p.is_available
    and not (p.id = any(coalesce(p_exclude_product_ids, '{}')))
    and (r.trigger_category_id is null
         or r.trigger_category_id = any(coalesce(p_category_ids, '{}')))
  order by p.id, r.sort_order
  limit greatest(p_limit, 0);
$$;

grant execute on function public.suggest_upsell(uuid, uuid[], uuid[], integer) to anon, authenticated;

-- ------------------------------------ RLS ------------------------------------
alter table public.carts        enable row level security;
alter table public.cart_items   enable row level security;
alter table public.upsell_rules enable row level security;

create policy carts_owner_all on public.carts
  for all to authenticated
  using (
    exists (select 1 from public.customers c
            where c.id = customer_id and c.auth_user_id = (select auth.uid()))
    or tenant_id = (select public.current_tenant_id())
  )
  with check (
    exists (select 1 from public.customers c
            where c.id = customer_id and c.auth_user_id = (select auth.uid()))
  );

create policy cart_items_owner_all on public.cart_items
  for all to authenticated
  using (
    exists (select 1 from public.carts ct
            join public.customers c on c.id = ct.customer_id
            where ct.id = cart_id and c.auth_user_id = (select auth.uid()))
    or tenant_id = (select public.current_tenant_id())
  )
  with check (
    exists (select 1 from public.carts ct
            join public.customers c on c.id = ct.customer_id
            where ct.id = cart_id and c.auth_user_id = (select auth.uid()))
  );

create policy upsell_rules_select on public.upsell_rules
  for select to anon, authenticated
  using (is_active or tenant_id = (select public.current_tenant_id()));

create policy upsell_rules_staff_write on public.upsell_rules
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));
