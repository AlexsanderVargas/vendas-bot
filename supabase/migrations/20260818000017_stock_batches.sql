-- =============================================================================
-- Migration: Estoque por lote, rastreabilidade FIFO/FEFO e movimentações
-- Fase 3 / PBI (issue #17) — Gestão de Produtos e Insumos
--
-- ingredients.stock_quantity continua sendo o saldo consolidado; os lotes
-- guardam de onde veio cada parcela e quando vence. As duas visões são
-- mantidas em sincronia pelas funções desta migration.
-- =============================================================================

create type public.stock_movement_type as enum ('in', 'out', 'loss', 'adjust');

-- -----------------------------------------------------------------------------
-- stock_batches: cada entrada de mercadoria vira um lote.
-- -----------------------------------------------------------------------------
create table public.stock_batches (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants (id) on delete cascade,
  ingredient_id      uuid not null references public.ingredients (id) on delete cascade,
  supplier_id        uuid references public.suppliers (id) on delete set null,
  batch_code         text,
  quantity_received  numeric(14,3) not null
                     constraint batches_received_positive check (quantity_received > 0),
  quantity_remaining numeric(14,3) not null
                     constraint batches_remaining_non_negative check (quantity_remaining >= 0),
  unit_cost          numeric(14,4) not null
                     constraint batches_cost_non_negative check (unit_cost >= 0),
  received_at        timestamptz not null default now(),
  expires_at         date,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint batches_remaining_lte_received check (quantity_remaining <= quantity_received)
);

-- Ordem de consumo: vencimento primeiro (FEFO) e, na falta dele, entrada
-- (FIFO). NULLS LAST deixa os sem validade no fim da fila de vencimento.
create index stock_batches_consumption_idx
  on public.stock_batches (ingredient_id, expires_at nulls last, received_at)
  where quantity_remaining > 0;

create index stock_batches_tenant_idx on public.stock_batches (tenant_id, received_at desc);
-- Alerta de vencimento próximo.
create index stock_batches_expiring_idx on public.stock_batches (tenant_id, expires_at)
  where quantity_remaining > 0 and expires_at is not null;

create trigger stock_batches_set_updated_at
  before update on public.stock_batches
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- stock_movements: extrato imutável de tudo que entrou e saiu.
-- -----------------------------------------------------------------------------
create table public.stock_movements (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  ingredient_id uuid not null references public.ingredients (id) on delete cascade,
  batch_id      uuid references public.stock_batches (id) on delete set null,
  order_id      uuid references public.orders (id) on delete set null,
  type          public.stock_movement_type not null,
  quantity      numeric(14,3) not null
                constraint movements_quantity_positive check (quantity > 0),
  unit_cost     numeric(14,4) not null default 0,
  reason        text,
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now()
);

create index stock_movements_ingredient_idx
  on public.stock_movements (ingredient_id, created_at desc);
create index stock_movements_tenant_idx on public.stock_movements (tenant_id, created_at desc);
create index stock_movements_order_idx on public.stock_movements (order_id)
  where order_id is not null;

-- -----------------------------------------------------------------------------
-- receive_stock(...)
-- Contrato ESTÁVEL: (p_ingredient_id uuid, p_quantity numeric, p_unit_cost numeric,
--   p_expires_at date, p_supplier_id uuid, p_batch_code text) -> jsonb
--   { "ok": bool, "error": text|null, "batchId": uuid|null,
--     "stockQuantity": numeric, "averageCost": numeric }
--
--   Cria o lote, registra a movimentação de entrada e recalcula o custo médio
--   ponderado do insumo. error: 'insumo_nao_encontrado' | 'nao_autorizado'
--   | 'validade_obrigatoria'
-- -----------------------------------------------------------------------------
create or replace function public.receive_stock(
  p_ingredient_id uuid,
  p_quantity      numeric,
  p_unit_cost     numeric,
  p_expires_at    date default null,
  p_supplier_id   uuid default null,
  p_batch_code    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ingredient public.ingredients%rowtype;
  v_batch_id   uuid;
  v_new_avg    numeric(14,4);
  v_new_qty    numeric(14,3);
begin
  select * into v_ingredient from public.ingredients where id = p_ingredient_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'insumo_nao_encontrado',
      'batchId', null, 'stockQuantity', 0, 'averageCost', 0);
  end if;

  if coalesce(v_ingredient.tenant_id = public.current_tenant_id(), false) is false then
    return jsonb_build_object('ok', false, 'error', 'nao_autorizado',
      'batchId', null, 'stockQuantity', 0, 'averageCost', 0);
  end if;

  -- Perecível sem validade quebraria a ordenação FEFO.
  if v_ingredient.is_perishable and p_expires_at is null then
    return jsonb_build_object('ok', false, 'error', 'validade_obrigatoria',
      'batchId', null, 'stockQuantity', v_ingredient.stock_quantity,
      'averageCost', v_ingredient.average_cost);
  end if;

  insert into public.stock_batches (tenant_id, ingredient_id, supplier_id, batch_code,
                                    quantity_received, quantity_remaining, unit_cost, expires_at)
  values (v_ingredient.tenant_id, p_ingredient_id, p_supplier_id, p_batch_code,
          p_quantity, p_quantity, p_unit_cost, p_expires_at)
  returning id into v_batch_id;

  insert into public.stock_movements (tenant_id, ingredient_id, batch_id, type,
                                      quantity, unit_cost, reason, created_by)
  values (v_ingredient.tenant_id, p_ingredient_id, v_batch_id, 'in',
          p_quantity, p_unit_cost, 'Entrada de mercadoria', auth.uid());

  -- Custo médio ponderado: saldo anterior + entrada.
  v_new_qty := v_ingredient.stock_quantity + p_quantity;
  v_new_avg := case
    when v_new_qty = 0 then p_unit_cost
    else round((v_ingredient.stock_quantity * v_ingredient.average_cost
                + p_quantity * p_unit_cost) / v_new_qty, 4)
  end;

  update public.ingredients
  set stock_quantity = v_new_qty, average_cost = v_new_avg
  where id = p_ingredient_id;

  return jsonb_build_object('ok', true, 'error', null, 'batchId', v_batch_id,
    'stockQuantity', v_new_qty, 'averageCost', v_new_avg);
end;
$$;

-- -----------------------------------------------------------------------------
-- consume_stock(...)
-- Contrato ESTÁVEL: (p_ingredient_id uuid, p_quantity numeric,
--   p_type public.stock_movement_type, p_reason text, p_order_id uuid) -> jsonb
--   { "ok": bool, "error": text|null, "consumed": numeric,
--     "stockQuantity": numeric, "batches": [{ "batchId", "quantity" }] }
--
--   Baixa a quantidade percorrendo os lotes em ordem FEFO (vencimento mais
--   próximo primeiro) e, entre lotes sem validade, FIFO.
--   Consome o que houver mesmo quando insuficiente, devolvendo
--   error = 'estoque_insuficiente' com o total realmente baixado — o registro
--   de consumo precisa refletir o que saiu da prateleira.
-- -----------------------------------------------------------------------------
create or replace function public.consume_stock(
  p_ingredient_id uuid,
  p_quantity      numeric,
  p_type          public.stock_movement_type default 'out',
  p_reason        text default null,
  p_order_id      uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ingredient public.ingredients%rowtype;
  v_batch      record;
  v_remaining  numeric(14,3) := p_quantity;
  v_take       numeric(14,3);
  v_consumed   numeric(14,3) := 0;
  v_batches    jsonb := '[]'::jsonb;
begin
  if p_quantity is null or p_quantity <= 0 then
    return jsonb_build_object('ok', false, 'error', 'quantidade_invalida',
      'consumed', 0, 'stockQuantity', 0, 'batches', v_batches);
  end if;

  select * into v_ingredient from public.ingredients where id = p_ingredient_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'insumo_nao_encontrado',
      'consumed', 0, 'stockQuantity', 0, 'batches', v_batches);
  end if;

  -- FEFO com FIFO como desempate. FOR UPDATE serializa baixas concorrentes
  -- sobre o mesmo lote.
  for v_batch in
    select id, quantity_remaining, unit_cost
    from public.stock_batches
    where ingredient_id = p_ingredient_id and quantity_remaining > 0
    order by expires_at nulls last, received_at
    for update
  loop
    exit when v_remaining <= 0;

    v_take := least(v_batch.quantity_remaining, v_remaining);

    update public.stock_batches
    set quantity_remaining = quantity_remaining - v_take
    where id = v_batch.id;

    insert into public.stock_movements (tenant_id, ingredient_id, batch_id, order_id,
                                        type, quantity, unit_cost, reason, created_by)
    values (v_ingredient.tenant_id, p_ingredient_id, v_batch.id, p_order_id,
            p_type, v_take, v_batch.unit_cost, p_reason, auth.uid());

    v_batches := v_batches || jsonb_build_array(
      jsonb_build_object('batchId', v_batch.id, 'quantity', v_take));
    v_consumed := v_consumed + v_take;
    v_remaining := v_remaining - v_take;
  end loop;

  if v_consumed > 0 then
    update public.ingredients
    set stock_quantity = stock_quantity - v_consumed
    where id = p_ingredient_id;
  end if;

  return jsonb_build_object(
    'ok', v_remaining <= 0,
    'error', case when v_remaining > 0 then 'estoque_insuficiente' else null end,
    'consumed', v_consumed,
    'stockQuantity', v_ingredient.stock_quantity - v_consumed,
    'batches', v_batches);
end;
$$;

grant execute on function public.receive_stock(uuid, numeric, numeric, date, uuid, text) to authenticated;
grant execute on function public.consume_stock(uuid, numeric, public.stock_movement_type, text, uuid) to authenticated;

-- ------------------------------------ RLS ------------------------------------
alter table public.stock_batches   enable row level security;
alter table public.stock_movements enable row level security;

create policy stock_batches_staff_all on public.stock_batches
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

-- Movimentações são um extrato: leitura pelo staff, escrita só pelas funções.
create policy stock_movements_staff_select on public.stock_movements
  for select to authenticated
  using (tenant_id = (select public.current_tenant_id()));
