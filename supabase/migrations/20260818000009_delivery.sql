-- =============================================================================
-- Migration: Logística de entrega — zonas por bairro, raio e taxa por distância
-- Fase 2 / PBI (issue #8) — Cardápio Digital e Delivery B2C
--
-- Complementa tenants.delivery_fee_mode (PBI 1) com os parâmetros de cada modo.
-- =============================================================================

-- Remoção de acentos para casar bairros digitados de formas diferentes.
create extension if not exists unaccent with schema extensions;

-- -----------------------------------------------------------------------------
-- normalize_place(value text) -> text
-- Contrato: (text) -> text — minúsculas, sem acento e sem espaços nas pontas.
-- IMMUTABLE (usa a forma de 2 argumentos de unaccent, que é imutável), o que
-- permite indexar a expressão.
-- -----------------------------------------------------------------------------
create or replace function public.normalize_place(value text)
returns text
language sql
immutable
strict
parallel safe
as $$
  select lower(trim(extensions.unaccent('extensions.unaccent'::regdictionary, value)));
$$;

alter table public.tenants
  add column delivery_base_fee      numeric(12,2) not null default 0
    constraint tenants_base_fee_non_negative check (delivery_base_fee >= 0),
  add column delivery_fee_per_km    numeric(12,2) not null default 0
    constraint tenants_fee_per_km_non_negative check (delivery_fee_per_km >= 0),
  -- Pedidos acima deste valor têm frete grátis. NULL = sem frete grátis.
  add column delivery_free_above    numeric(12,2)
    constraint tenants_free_above_positive check (delivery_free_above is null or delivery_free_above > 0),
  add column delivery_max_distance_km numeric(6,2)
    constraint tenants_max_distance_positive check (delivery_max_distance_km is null or delivery_max_distance_km > 0),
  add column delivery_min_order     numeric(12,2) not null default 0
    constraint tenants_min_order_non_negative check (delivery_min_order >= 0),
  add column delivery_eta_minutes   integer
    constraint tenants_eta_positive check (delivery_eta_minutes is null or delivery_eta_minutes > 0);

-- -----------------------------------------------------------------------------
-- delivery_zones: taxa fixa por bairro (modo 'neighborhood').
-- Bairro normalizado em minúsculas sem acento para casar com o endereço do
-- cliente sem depender de digitação exata.
-- -----------------------------------------------------------------------------
create table public.delivery_zones (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  neighborhood text not null constraint zones_neighborhood_len check (char_length(neighborhood) between 1 and 120),
  city         text not null,
  fee          numeric(12,2) not null constraint zones_fee_non_negative check (fee >= 0),
  min_order    numeric(12,2) not null default 0 constraint zones_min_order_non_negative check (min_order >= 0),
  eta_minutes  integer constraint zones_eta_positive check (eta_minutes is null or eta_minutes > 0),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Chave de busca normalizada: um bairro por cidade por tenant.
create unique index delivery_zones_lookup
  on public.delivery_zones (tenant_id, public.normalize_place(neighborhood), public.normalize_place(city));

create trigger delivery_zones_set_updated_at
  before update on public.delivery_zones
  for each row execute function public.set_updated_at();

alter table public.delivery_zones enable row level security;

create policy delivery_zones_select on public.delivery_zones
  for select to anon, authenticated
  using (is_active or tenant_id = (select public.current_tenant_id()));

create policy delivery_zones_staff_write on public.delivery_zones
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

-- -----------------------------------------------------------------------------
-- quote_delivery(...)
-- Contrato ESTÁVEL: (p_tenant_id uuid, p_subtotal numeric, p_latitude double
--   precision, p_longitude double precision, p_neighborhood text, p_city text)
--   -> jsonb
--
-- Saída (chaves fixas):
--   { "eligible": bool, "fee": numeric, "mode": text, "distance_meters": numeric|null,
--     "eta_minutes": int|null, "min_order": numeric, "reason": text|null }
--
-- reason (quando eligible = false): 'estabelecimento_inativo' | 'sem_localizacao'
--   | 'fora_da_area' | 'bairro_nao_atendido' | 'pedido_minimo'
--
-- STABLE + SECURITY DEFINER: precisa ler tenants/delivery_zones mesmo para
-- visitante anônimo cotando o frete antes de fazer login.
-- -----------------------------------------------------------------------------
create or replace function public.quote_delivery(
  p_tenant_id    uuid,
  p_subtotal     numeric default 0,
  p_latitude     double precision default null,
  p_longitude    double precision default null,
  p_neighborhood text default null,
  p_city         text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant   public.tenants%rowtype;
  v_zone     public.delivery_zones%rowtype;
  v_distance numeric;
  v_fee      numeric;
  v_eta      integer;
  v_min      numeric;
  v_point    extensions.geography;
begin
  select * into v_tenant from public.tenants where id = p_tenant_id;

  if not found or not v_tenant.is_active then
    return jsonb_build_object('eligible', false, 'fee', 0, 'mode', null,
      'distance_meters', null, 'eta_minutes', null, 'min_order', 0,
      'reason', 'estabelecimento_inativo');
  end if;

  v_min := v_tenant.delivery_min_order;
  v_eta := v_tenant.delivery_eta_minutes;

  if v_tenant.delivery_fee_mode = 'fixed' then
    v_fee := v_tenant.delivery_base_fee;

  elsif v_tenant.delivery_fee_mode = 'distance' then
    if p_latitude is null or p_longitude is null or v_tenant.location is null then
      return jsonb_build_object('eligible', false, 'fee', 0, 'mode', 'distance',
        'distance_meters', null, 'eta_minutes', v_eta, 'min_order', v_min,
        'reason', 'sem_localizacao');
    end if;

    v_point := extensions.ST_SetSRID(
                 extensions.ST_MakePoint(p_longitude, p_latitude), 4326)::extensions.geography;
    v_distance := round(extensions.ST_Distance(v_tenant.location, v_point)::numeric, 2);

    if v_tenant.delivery_max_distance_km is not null
       and v_distance > v_tenant.delivery_max_distance_km * 1000 then
      return jsonb_build_object('eligible', false, 'fee', 0, 'mode', 'distance',
        'distance_meters', v_distance, 'eta_minutes', v_eta, 'min_order', v_min,
        'reason', 'fora_da_area');
    end if;

    v_fee := round(v_tenant.delivery_base_fee
                   + v_tenant.delivery_fee_per_km * (v_distance / 1000.0), 2);

  else -- 'neighborhood'
    if p_neighborhood is null or p_city is null then
      return jsonb_build_object('eligible', false, 'fee', 0, 'mode', 'neighborhood',
        'distance_meters', null, 'eta_minutes', v_eta, 'min_order', v_min,
        'reason', 'bairro_nao_atendido');
    end if;

    select * into v_zone
    from public.delivery_zones z
    where z.tenant_id = p_tenant_id
      and z.is_active
      and public.normalize_place(z.neighborhood) = public.normalize_place(p_neighborhood)
      and public.normalize_place(z.city) = public.normalize_place(p_city);

    if not found then
      return jsonb_build_object('eligible', false, 'fee', 0, 'mode', 'neighborhood',
        'distance_meters', null, 'eta_minutes', v_eta, 'min_order', v_min,
        'reason', 'bairro_nao_atendido');
    end if;

    v_fee := v_zone.fee;
    v_min := greatest(v_min, v_zone.min_order);
    v_eta := coalesce(v_zone.eta_minutes, v_eta);
  end if;

  -- Frete grátis acima do valor configurado.
  if v_tenant.delivery_free_above is not null and p_subtotal >= v_tenant.delivery_free_above then
    v_fee := 0;
  end if;

  -- Pedido mínimo é avaliado por último: a taxa já calculada segue informada,
  -- para a tela mostrar quanto falta para atingir o mínimo.
  if p_subtotal < v_min then
    return jsonb_build_object('eligible', false, 'fee', v_fee,
      'mode', v_tenant.delivery_fee_mode, 'distance_meters', v_distance,
      'eta_minutes', v_eta, 'min_order', v_min, 'reason', 'pedido_minimo');
  end if;

  return jsonb_build_object('eligible', true, 'fee', v_fee,
    'mode', v_tenant.delivery_fee_mode, 'distance_meters', v_distance,
    'eta_minutes', v_eta, 'min_order', v_min, 'reason', null);
end;
$$;

grant execute on function public.quote_delivery(uuid, numeric, double precision, double precision, text, text)
  to anon, authenticated;
