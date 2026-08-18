-- =============================================================================
-- Migration: KDS — fila de preparo por item
-- Fase 4 / PBI (issue #24) — Organização do Estabelecimento
--
-- O status do PEDIDO diz onde ele está no fluxo comercial; o status do ITEM
-- diz o que a cozinha já produziu. Um pedido pode ter a batata pronta e o
-- hambúrguer ainda na chapa.
-- =============================================================================

create type public.prep_status as enum ('pending', 'preparing', 'ready', 'served', 'canceled');

alter table public.order_items
  add column prep_status  public.prep_status not null default 'pending',
  add column started_at   timestamptz,
  add column ready_at     timestamptz,
  -- Itens que não passam pela cozinha (bebidas de balcão) saem da fila.
  add column requires_prep boolean not null default true;

-- Fila do KDS: itens pendentes/em preparo do tenant, mais antigos primeiro.
create index order_items_kds_idx on public.order_items (tenant_id, prep_status, created_at)
  where requires_prep and prep_status in ('pending', 'preparing');

-- -----------------------------------------------------------------------------
-- can_transition_prep(from, to)
-- Contrato ESTÁVEL: (prep_status, prep_status) -> boolean
-- -----------------------------------------------------------------------------
create or replace function public.can_transition_prep(
  p_from public.prep_status,
  p_to   public.prep_status
)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case p_from
    when 'pending'   then p_to in ('preparing', 'ready', 'canceled')
    when 'preparing' then p_to in ('ready', 'canceled')
    when 'ready'     then p_to in ('served', 'preparing')  -- voltar ao fogo se esfriou
    when 'served'    then false
    when 'canceled'  then false
    else false
  end;
$$;

create or replace function public.guard_prep_transition()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.prep_status is distinct from old.prep_status then
    if not public.can_transition_prep(old.prep_status, new.prep_status) then
      raise exception 'transição de preparo inválida: % -> %', old.prep_status, new.prep_status
        using errcode = 'check_violation';
    end if;
    if new.prep_status = 'preparing' and new.started_at is null then
      new.started_at := now();
    end if;
    if new.prep_status = 'ready' and new.ready_at is null then
      new.ready_at := now();
    end if;
  end if;
  return new;
end;
$$;

create trigger order_items_guard_prep
  before update of prep_status on public.order_items
  for each row execute function public.guard_prep_transition();

-- -----------------------------------------------------------------------------
-- advance_item_prep(p_item_id uuid, p_status public.prep_status)
-- Contrato ESTÁVEL: -> jsonb { "ok": bool, "error": text|null,
--   "itemStatus": text|null, "orderReady": bool }
--   orderReady indica que todos os itens do pedido ficaram prontos — é o
--   gancho para o painel avisar o garçom.
--   error: 'item_nao_encontrado' | 'nao_autorizado' | 'transicao_invalida'
-- -----------------------------------------------------------------------------
create or replace function public.advance_item_prep(
  p_item_id uuid,
  p_status  public.prep_status
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item      public.order_items%rowtype;
  v_pending   integer;
begin
  select * into v_item from public.order_items where id = p_item_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'item_nao_encontrado',
      'itemStatus', null, 'orderReady', false);
  end if;

  if coalesce(v_item.tenant_id = public.current_tenant_id(), false) is false then
    return jsonb_build_object('ok', false, 'error', 'nao_autorizado',
      'itemStatus', null, 'orderReady', false);
  end if;

  if not public.can_transition_prep(v_item.prep_status, p_status) then
    return jsonb_build_object('ok', false, 'error', 'transicao_invalida',
      'itemStatus', v_item.prep_status::text, 'orderReady', false);
  end if;

  update public.order_items set prep_status = p_status where id = p_item_id;

  select count(*) into v_pending
  from public.order_items
  where order_id = v_item.order_id
    and requires_prep
    and prep_status in ('pending', 'preparing');

  return jsonb_build_object('ok', true, 'error', null,
    'itemStatus', p_status::text, 'orderReady', v_pending = 0);
end;
$$;

-- -----------------------------------------------------------------------------
-- kds_queue(p_tenant_id uuid)
-- Contrato ESTÁVEL: -> setof (order_id uuid, order_number bigint, channel text,
--   table_label text, item_id uuid, product_name text, quantity numeric,
--   notes text, selected_options jsonb, prep_status text,
--   waiting_seconds integer)
--   Fila de preparo do estabelecimento, mais antigos primeiro.
-- -----------------------------------------------------------------------------
create or replace function public.kds_queue(p_tenant_id uuid)
returns table (
  order_id        uuid,
  order_number    bigint,
  channel         text,
  table_label     text,
  item_id         uuid,
  product_name    text,
  quantity        numeric,
  notes           text,
  selected_options jsonb,
  prep_status     text,
  waiting_seconds integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.order_number, o.channel::text, t.label,
         oi.id, oi.product_name, oi.quantity, oi.notes, oi.selected_options,
         oi.prep_status::text,
         greatest(0, extract(epoch from (now() - oi.created_at))::integer)
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  left join public.dining_tables t on t.id = o.table_id
  where oi.tenant_id = p_tenant_id
    and oi.requires_prep
    and oi.prep_status in ('pending', 'preparing')
    and o.status in ('placed', 'confirmed', 'preparing', 'ready')
  order by oi.created_at;
$$;

grant execute on function public.advance_item_prep(uuid, public.prep_status) to authenticated;
grant execute on function public.kds_queue(uuid) to authenticated;

-- Realtime: a fila da cozinha atualiza sozinha.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    -- order_items já está publicada desde o PBI 1; nada a adicionar.
    null;
  end if;
end;
$$;
