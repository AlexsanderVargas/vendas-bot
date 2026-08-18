-- =============================================================================
-- Migration: Vendas — orders, order_items, numeração por tenant
-- PBI 1 (issue #2) — Database Core & B2C
--
-- Decisões:
--  * order_number sequencial POR TENANT (tenant_counters + trigger), gerando
--    números amigáveis ("Pedido nº 42") sem colisão entre estabelecimentos.
--  * Snapshots imutáveis: delivery_address (jsonb) e product_name/unit_price
--    nos itens — mudanças posteriores de cadastro não reescrevem o histórico.
--  * Enums cobrem delivery, retirada e consumo no salão (mesas chegam na
--    Feature de Operação Interna; channel='dine_in' já está previsto).
-- =============================================================================

create type public.order_channel as enum ('delivery', 'takeaway', 'dine_in');

create type public.order_status as enum (
  'draft',            -- carrinho convertido, ainda não confirmado pelo cliente
  'placed',           -- pedido realizado
  'confirmed',        -- aceito pelo estabelecimento
  'preparing',        -- em preparo (KDS)
  'ready',            -- pronto (aguardando entrega/retirada/servir)
  'out_for_delivery', -- saiu para entrega
  'delivered',        -- entregue ao cliente
  'completed',        -- finalizado (pago e encerrado)
  'canceled'          -- cancelado
);

create type public.payment_status as enum ('pending', 'paid', 'refunded', 'failed');

-- -----------------------------------------------------------------------------
-- tenant_counters: contadores transacionais por tenant (numeração de pedidos,
-- futuramente comandas, NFC-e etc.). Sem políticas RLS — acesso apenas via
-- funções SECURITY DEFINER e service_role.
-- -----------------------------------------------------------------------------
create table public.tenant_counters (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  key       text not null,
  value     bigint not null default 0,
  primary key (tenant_id, key)
);

-- -----------------------------------------------------------------------------
-- next_order_number(p_tenant_id uuid)
-- Contrato: (uuid) -> bigint  (ESTÁVEL — ver docs/engineering-rules.md)
--   Incrementa e retorna, de forma atômica (upsert), o próximo número de
--   pedido do tenant. SECURITY DEFINER: chamada pelo trigger de orders sem
--   expor tenant_counters aos clientes.
-- -----------------------------------------------------------------------------
create or replace function public.next_order_number(p_tenant_id uuid)
returns bigint
language sql
security definer
set search_path = ''
as $$
  insert into public.tenant_counters as tc (tenant_id, key, value)
  values (p_tenant_id, 'order_number', 1)
  on conflict (tenant_id, key)
  do update set value = tc.value + 1
  returning tc.value;
$$;

revoke execute on function public.next_order_number(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- orders
-- -----------------------------------------------------------------------------
create table public.orders (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants (id) on delete restrict,
  customer_id         uuid references public.customers (id) on delete set null, -- null em pedidos internos (mesa/balcão)
  -- Preenchido pelo trigger orders_assign_number quando omitido no insert
  -- (NOT NULL é validado após triggers BEFORE INSERT).
  order_number        bigint not null constraint orders_number_positive check (order_number > 0),
  channel             public.order_channel not null,
  status              public.order_status not null default 'placed',
  payment_status      public.payment_status not null default 'pending',
  -- Snapshot do endereço no momento do pedido (imutável) + referência viva opcional
  delivery_address    jsonb,
  delivery_address_id uuid references public.customer_addresses (id) on delete set null,
  subtotal            numeric(12,2) not null default 0 constraint orders_subtotal_non_negative check (subtotal >= 0),
  discount            numeric(12,2) not null default 0 constraint orders_discount_non_negative check (discount >= 0),
  delivery_fee        numeric(12,2) not null default 0 constraint orders_fee_non_negative check (delivery_fee >= 0),
  total               numeric(12,2) not null default 0,
  notes               text,
  placed_at           timestamptz,
  delivered_at        timestamptz,
  canceled_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint orders_tenant_number_unique unique (tenant_id, order_number),
  constraint orders_total_consistent check (total = subtotal - discount + delivery_fee),
  constraint orders_delivery_needs_address check (channel <> 'delivery' or delivery_address is not null)
);

-- Painéis operacionais (KDS, acompanhamento): pedidos abertos por tenant.
create index orders_tenant_status_idx on public.orders (tenant_id, status, created_at);
-- Histórico do tenant (listagens paginadas por data).
create index orders_tenant_created_idx on public.orders (tenant_id, created_at desc);
-- Painel do cliente ("meus pedidos").
create index orders_customer_idx on public.orders (customer_id, created_at desc)
  where customer_id is not null;
create index orders_delivery_address_idx on public.orders (delivery_address_id)
  where delivery_address_id is not null;

create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- assign_order_number()
-- Contrato: trigger BEFORE INSERT em orders.
--   Preenche order_number via next_order_number() quando não informado
--   (inserts de service_role podem pré-atribuir em importações).
-- -----------------------------------------------------------------------------
create or replace function public.assign_order_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.order_number is null then
    new.order_number := public.next_order_number(new.tenant_id);
  end if;
  if new.status <> 'draft' and new.placed_at is null then
    new.placed_at := now();
  end if;
  return new;
end;
$$;

create trigger orders_assign_number
  before insert on public.orders
  for each row execute function public.assign_order_number();

-- -----------------------------------------------------------------------------
-- order_items
-- total é coluna gerada (unit_price * quantity) — consistência garantida no banco.
-- -----------------------------------------------------------------------------
create table public.order_items (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references public.orders (id) on delete cascade,
  tenant_id    uuid not null references public.tenants (id) on delete restrict,
  product_id   uuid references public.products (id) on delete set null,
  product_name text not null,                 -- snapshot do nome no momento da venda
  unit_price   numeric(12,2) not null constraint items_price_non_negative check (unit_price >= 0),
  quantity     numeric(10,3) not null constraint items_quantity_positive check (quantity > 0),
  total        numeric(12,2) not null generated always as (round(unit_price * quantity, 2)) stored,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index order_items_order_idx on public.order_items (order_id);
create index order_items_tenant_product_idx on public.order_items (tenant_id, product_id); -- ranking de vendas / CMV futuro

create trigger order_items_set_updated_at
  before update on public.order_items
  for each row execute function public.set_updated_at();
