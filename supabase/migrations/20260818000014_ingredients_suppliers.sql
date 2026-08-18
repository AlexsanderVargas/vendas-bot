-- =============================================================================
-- Migration: Insumos, unidades de medida e fornecedores
-- Fase 3 / PBI (issue #15) — Gestão de Produtos e Insumos
-- =============================================================================

-- Unidade base de cada insumo. A conversão para a unidade de compra fica em
-- ingredients.purchase_factor (ex.: compra em caixa de 12 kg).
create type public.unit_of_measure as enum ('g', 'kg', 'ml', 'l', 'un');

-- -----------------------------------------------------------------------------
-- convert_to_base(value numeric, from_unit, to_unit)
-- Contrato ESTÁVEL: (numeric, unit_of_measure, unit_of_measure) -> numeric
--   Converte entre unidades da mesma família (massa ou volume). Devolve NULL
--   quando a conversão não faz sentido (ex.: kg -> l), para o chamador tratar
--   explicitamente em vez de gravar número errado.
-- -----------------------------------------------------------------------------
create or replace function public.convert_to_base(
  p_value numeric,
  p_from  public.unit_of_measure,
  p_to    public.unit_of_measure
)
returns numeric
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when p_from = p_to then p_value
    when p_from = 'kg' and p_to = 'g'  then p_value * 1000
    when p_from = 'g'  and p_to = 'kg' then p_value / 1000
    when p_from = 'l'  and p_to = 'ml' then p_value * 1000
    when p_from = 'ml' and p_to = 'l'  then p_value / 1000
    else null
  end;
$$;

-- -----------------------------------------------------------------------------
-- suppliers: fornecedores do estabelecimento.
-- -----------------------------------------------------------------------------
create table public.suppliers (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  name         text not null constraint suppliers_name_len check (char_length(name) between 1 and 160),
  document     text constraint suppliers_document_format
               check (document is null or document ~ '^[0-9]{11}$|^[0-9]{14}$'), -- CPF ou CNPJ
  email        extensions.citext,
  phone        text,
  contact_name text,
  notes        text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- NULLs distintos (padrão): vários fornecedores podem não ter documento,
  -- mas dois com o mesmo CNPJ no mesmo tenant são barrados.
  constraint suppliers_tenant_document_unique unique (tenant_id, document)
);

create index suppliers_tenant_idx on public.suppliers (tenant_id) where is_active;
create index suppliers_name_trgm on public.suppliers using gin (name extensions.gin_trgm_ops);

create trigger suppliers_set_updated_at
  before update on public.suppliers
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- ingredients: insumos. O estoque é mantido sempre na unidade base
-- (stock_quantity), e a compra pode ocorrer em outra unidade.
-- -----------------------------------------------------------------------------
create table public.ingredients (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  name            text not null constraint ingredients_name_len check (char_length(name) between 1 and 120),
  sku             text,
  base_unit       public.unit_of_measure not null,
  -- Custo médio por unidade base, recalculado a cada entrada de lote.
  average_cost    numeric(14,4) not null default 0
                  constraint ingredients_avg_cost_non_negative check (average_cost >= 0),
  stock_quantity  numeric(14,3) not null default 0,
  minimum_stock   numeric(14,3) not null default 0
                  constraint ingredients_min_stock_non_negative check (minimum_stock >= 0),
  is_perishable   boolean not null default false,
  -- Insumo perecível exige controle de validade nos lotes.
  shelf_life_days integer constraint ingredients_shelf_life_positive
                  check (shelf_life_days is null or shelf_life_days > 0),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint ingredients_tenant_name_unique unique (tenant_id, name),
  -- NULLs distintos: SKU é opcional, então vários insumos podem ficar sem ele.
  constraint ingredients_tenant_sku_unique unique (tenant_id, sku)
);

create index ingredients_tenant_idx on public.ingredients (tenant_id) where is_active;
create index ingredients_name_trgm on public.ingredients using gin (name extensions.gin_trgm_ops);
-- Consulta de reposição: insumos abaixo do mínimo.
create index ingredients_below_minimum_idx on public.ingredients (tenant_id)
  where is_active and stock_quantity <= minimum_stock;

create trigger ingredients_set_updated_at
  before update on public.ingredients
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- ingredient_suppliers: de quem se compra cada insumo, em que unidade e por
-- quanto. purchase_factor converte a unidade de compra para a unidade base.
-- -----------------------------------------------------------------------------
create table public.ingredient_suppliers (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  ingredient_id   uuid not null references public.ingredients (id) on delete cascade,
  supplier_id     uuid not null references public.suppliers (id) on delete cascade,
  purchase_unit   public.unit_of_measure not null,
  -- Quantidade em unidade base contida em 1 unidade de compra.
  purchase_factor numeric(14,4) not null default 1
                  constraint ingredient_suppliers_factor_positive check (purchase_factor > 0),
  last_price      numeric(14,4)
                  constraint ingredient_suppliers_price_non_negative
                  check (last_price is null or last_price >= 0),
  supplier_code   text,
  lead_time_days  integer constraint ingredient_suppliers_lead_time_non_negative
                  check (lead_time_days is null or lead_time_days >= 0),
  is_preferred    boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint ingredient_suppliers_unique unique (ingredient_id, supplier_id)
);

create index ingredient_suppliers_ingredient_idx on public.ingredient_suppliers (ingredient_id);
create index ingredient_suppliers_supplier_idx on public.ingredient_suppliers (supplier_id);
-- No máximo um fornecedor preferencial por insumo.
create unique index ingredient_suppliers_one_preferred
  on public.ingredient_suppliers (ingredient_id) where is_preferred;

create trigger ingredient_suppliers_set_updated_at
  before update on public.ingredient_suppliers
  for each row execute function public.set_updated_at();

-- tenant_id derivado do insumo (padrão do PBI 1).
create or replace function public.sync_ingredient_supplier_tenant()
returns trigger language plpgsql set search_path = '' as $$
begin
  select i.tenant_id into strict new.tenant_id
  from public.ingredients i where i.id = new.ingredient_id;

  -- Fornecedor precisa ser do mesmo estabelecimento.
  if not exists (select 1 from public.suppliers s
                 where s.id = new.supplier_id and s.tenant_id = new.tenant_id) then
    raise exception 'fornecedor pertence a outro estabelecimento'
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end;
$$;

create trigger ingredient_suppliers_sync_tenant
  before insert or update of ingredient_id, supplier_id on public.ingredient_suppliers
  for each row execute function public.sync_ingredient_supplier_tenant();

-- ------------------------------------ RLS ------------------------------------
-- Insumos e fornecedores são dados internos: nenhuma leitura pública.
alter table public.suppliers            enable row level security;
alter table public.ingredients          enable row level security;
alter table public.ingredient_suppliers enable row level security;

create policy suppliers_staff_all on public.suppliers
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

create policy ingredients_staff_all on public.ingredients
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

create policy ingredient_suppliers_staff_all on public.ingredient_suppliers
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));
