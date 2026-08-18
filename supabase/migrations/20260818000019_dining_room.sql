-- =============================================================================
-- Migration: Salão — setores e mesas com status em tempo real
-- Fase 4 / PBI (issue #21) — Organização do Estabelecimento
-- =============================================================================

create type public.table_status as enum (
  'free',      -- Livre
  'occupied',  -- Ocupada
  'billing',   -- Fechando conta
  'cleaning',  -- Aguardando limpeza
  'reserved',  -- Reservada
  'inactive'   -- Fora de uso
);

-- -----------------------------------------------------------------------------
-- dining_sectors: áreas do salão (Interno, Varanda, Mezanino).
-- -----------------------------------------------------------------------------
create table public.dining_sectors (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  name       text not null constraint sectors_name_len check (char_length(name) between 1 and 80),
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sectors_tenant_name_unique unique (tenant_id, name)
);

create index dining_sectors_tenant_idx on public.dining_sectors (tenant_id, sort_order);

create trigger dining_sectors_set_updated_at
  before update on public.dining_sectors
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- dining_tables: mesas do salão.
-- -----------------------------------------------------------------------------
create table public.dining_tables (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  sector_id  uuid references public.dining_sectors (id) on delete set null,
  label      text not null constraint tables_label_len check (char_length(label) between 1 and 20),
  seats      smallint not null default 4 constraint tables_seats_positive check (seats > 0),
  status     public.table_status not null default 'free',
  -- Posição opcional no mapa do salão (percentual da área, 0 a 100).
  map_x      numeric(5,2) constraint tables_map_x_range check (map_x is null or map_x between 0 and 100),
  map_y      numeric(5,2) constraint tables_map_y_range check (map_y is null or map_y between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tables_tenant_label_unique unique (tenant_id, label)
);

-- Consulta do mapa do salão em tempo real.
create index dining_tables_tenant_status_idx on public.dining_tables (tenant_id, status);
create index dining_tables_sector_idx on public.dining_tables (sector_id);

create trigger dining_tables_set_updated_at
  before update on public.dining_tables
  for each row execute function public.set_updated_at();

-- Setor precisa ser do mesmo estabelecimento da mesa.
create or replace function public.check_table_sector_tenant()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.sector_id is not null
     and not exists (select 1 from public.dining_sectors s
                     where s.id = new.sector_id and s.tenant_id = new.tenant_id) then
    raise exception 'setor pertence a outro estabelecimento'
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end;
$$;

create trigger dining_tables_check_sector
  before insert or update of sector_id on public.dining_tables
  for each row execute function public.check_table_sector_tenant();

-- -----------------------------------------------------------------------------
-- can_transition_table(from, to)
-- Contrato ESTÁVEL: (table_status, table_status) -> boolean
--   Impede saltos que escondem etapas do salão — por exemplo, ir de ocupada
--   direto para livre sem passar por limpeza.
-- -----------------------------------------------------------------------------
create or replace function public.can_transition_table(
  p_from public.table_status,
  p_to   public.table_status
)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when p_from = p_to then true
    when p_to = 'inactive' or p_from = 'inactive' then true  -- manutenção entra e sai a qualquer momento
    when p_from = 'free'     then p_to in ('occupied', 'reserved', 'cleaning')
    when p_from = 'reserved' then p_to in ('occupied', 'free')
    when p_from = 'occupied' then p_to in ('billing', 'cleaning')
    when p_from = 'billing'  then p_to in ('cleaning', 'occupied')
    when p_from = 'cleaning' then p_to in ('free')
    else false
  end;
$$;

create or replace function public.guard_table_transition()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from old.status
     and not public.can_transition_table(old.status, new.status) then
    raise exception 'mudança de status de mesa inválida: % -> %', old.status, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger dining_tables_guard_transition
  before update of status on public.dining_tables
  for each row execute function public.guard_table_transition();

-- ------------------------------------ RLS ------------------------------------
alter table public.dining_sectors enable row level security;
alter table public.dining_tables  enable row level security;

create policy dining_sectors_staff_all on public.dining_sectors
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

create policy dining_tables_staff_all on public.dining_tables
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

-- Realtime: o mapa do salão atualiza sem refresh.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.dining_tables;
  end if;
end;
$$;

-- Permissões de salão nos papéis de sistema.
update public.roles
set permissions = permissions || '{"tables.read": true, "tables.write": true}'::jsonb
where tenant_id is null and key in ('owner', 'manager', 'waiter');

update public.roles
set permissions = permissions || '{"tables.read": true}'::jsonb
where tenant_id is null and key in ('cashier', 'kitchen');
