-- =============================================================================
-- Migration: Ficha técnica e cálculo de CMV
-- Fase 3 / PBI (issue #16) — Gestão de Produtos e Insumos
-- =============================================================================

-- -----------------------------------------------------------------------------
-- product_recipes: composição de cada produto de venda.
-- quantity é sempre na unidade BASE do insumo (ingredients.base_unit); a
-- conversão a partir da unidade digitada é responsabilidade do chamador
-- (convert_to_base), para o banco guardar um número só e comparável.
-- waste_percent cobre perda de preparo (aparas, evaporação).
-- -----------------------------------------------------------------------------
create table public.product_recipes (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  product_id    uuid not null references public.products (id) on delete cascade,
  ingredient_id uuid not null references public.ingredients (id) on delete restrict,
  quantity      numeric(14,4) not null constraint recipes_quantity_positive check (quantity > 0),
  waste_percent numeric(5,2) not null default 0
                constraint recipes_waste_range check (waste_percent >= 0 and waste_percent < 100),
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint product_recipes_unique unique (product_id, ingredient_id)
);

create index product_recipes_product_idx on public.product_recipes (product_id);
-- "Que pratos usam este insumo?" — usado na baixa e na análise de impacto.
create index product_recipes_ingredient_idx on public.product_recipes (ingredient_id);

create trigger product_recipes_set_updated_at
  before update on public.product_recipes
  for each row execute function public.set_updated_at();

-- tenant_id derivado do produto; o insumo precisa ser do mesmo estabelecimento.
create or replace function public.sync_recipe_tenant()
returns trigger language plpgsql set search_path = '' as $$
begin
  select p.tenant_id into strict new.tenant_id
  from public.products p where p.id = new.product_id;

  if not exists (select 1 from public.ingredients i
                 where i.id = new.ingredient_id and i.tenant_id = new.tenant_id) then
    raise exception 'insumo pertence a outro estabelecimento'
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end;
$$;

create trigger product_recipes_sync_tenant
  before insert or update of product_id, ingredient_id on public.product_recipes
  for each row execute function public.sync_recipe_tenant();

-- -----------------------------------------------------------------------------
-- recipe_effective_quantity(quantity, waste_percent)
-- Contrato ESTÁVEL: (numeric, numeric) -> numeric
--   Quantidade realmente consumida do estoque, incluindo a perda de preparo.
--   Uma ficha de 100 g com 10% de perda consome 100 / 0,9 ≈ 111,11 g.
-- -----------------------------------------------------------------------------
create or replace function public.recipe_effective_quantity(
  p_quantity      numeric,
  p_waste_percent numeric
)
returns numeric
language sql
immutable
parallel safe
set search_path = ''
as $$
  select round(p_quantity / (1 - coalesce(p_waste_percent, 0) / 100.0), 4);
$$;

-- -----------------------------------------------------------------------------
-- product_cmv(p_product_id uuid)
-- Contrato ESTÁVEL: (uuid) -> numeric
--   Custo da mercadoria vendida: soma de (quantidade efetiva x custo médio do
--   insumo). Produto sem ficha técnica devolve 0 — o chamador distingue isso
--   por product_margin().hasRecipe.
-- -----------------------------------------------------------------------------
create or replace function public.product_cmv(p_product_id uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce(round(sum(
    public.recipe_effective_quantity(r.quantity, r.waste_percent) * i.average_cost
  ), 2), 0)
  from public.product_recipes r
  join public.ingredients i on i.id = r.ingredient_id
  where r.product_id = p_product_id;
$$;

-- -----------------------------------------------------------------------------
-- product_margin(p_product_id uuid)
-- Contrato ESTÁVEL: (uuid) -> jsonb
--   { "price": numeric, "cmv": numeric, "margin": numeric,
--     "marginPercent": numeric, "hasRecipe": bool }
--   marginPercent é a margem de contribuição sobre o preço de venda.
-- -----------------------------------------------------------------------------
create or replace function public.product_margin(p_product_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_price      numeric;
  v_cmv        numeric;
  v_has_recipe boolean;
begin
  select price into v_price from public.products where id = p_product_id;
  if not found then
    return jsonb_build_object('price', 0, 'cmv', 0, 'margin', 0,
                              'marginPercent', 0, 'hasRecipe', false);
  end if;

  v_cmv := public.product_cmv(p_product_id);
  v_has_recipe := exists (select 1 from public.product_recipes where product_id = p_product_id);

  return jsonb_build_object(
    'price', v_price,
    'cmv', v_cmv,
    'margin', round(v_price - v_cmv, 2),
    'marginPercent', case when v_price = 0 then 0
                          else round((v_price - v_cmv) * 100 / v_price, 2) end,
    'hasRecipe', v_has_recipe);
end;
$$;

grant execute on function public.product_cmv(uuid) to authenticated;
grant execute on function public.product_margin(uuid) to authenticated;

-- ------------------------------------ RLS ------------------------------------
-- A ficha técnica é segredo do negócio: sem leitura pública.
alter table public.product_recipes enable row level security;

create policy product_recipes_staff_all on public.product_recipes
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));
