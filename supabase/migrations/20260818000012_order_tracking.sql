-- =============================================================================
-- Migration: Rastreamento de pedido — linha do tempo e transições validadas
-- Fase 2 / PBI (issue #11) — Cardápio Digital e Delivery B2C
-- =============================================================================

-- -----------------------------------------------------------------------------
-- can_transition_order(from, to)
-- Contrato ESTÁVEL: (order_status, order_status) -> boolean
--   FONTE DA VERDADE das transições de status. O espelho em TypeScript
--   (packages/shared/src/contracts/enums.ts) existe só para a UI antecipar
--   o que o servidor aceitaria — qualquer mudança precisa ser feita nos dois.
-- -----------------------------------------------------------------------------
create or replace function public.can_transition_order(
  p_from public.order_status,
  p_to   public.order_status
)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case p_from
    when 'draft'            then p_to in ('placed', 'canceled')
    when 'placed'           then p_to in ('confirmed', 'canceled')
    when 'confirmed'        then p_to in ('preparing', 'canceled')
    when 'preparing'        then p_to in ('ready', 'canceled')
    when 'ready'            then p_to in ('out_for_delivery', 'delivered', 'completed', 'canceled')
    when 'out_for_delivery' then p_to in ('delivered', 'canceled')
    when 'delivered'        then p_to in ('completed')
    else false
  end;
$$;

-- -----------------------------------------------------------------------------
-- order_status_events: linha do tempo do pedido, alimentada por trigger.
-- É o que o painel do cliente mostra e o que o Realtime transmite.
-- -----------------------------------------------------------------------------
create table public.order_status_events (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references public.orders (id) on delete cascade,
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  status     public.order_status not null,
  note       text,
  changed_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index order_status_events_order_idx on public.order_status_events (order_id, created_at);

-- -----------------------------------------------------------------------------
-- Trigger de transição: valida o salto de status e registra o evento.
-- Contrato: trigger BEFORE UPDATE OF status / AFTER INSERT em orders.
-- -----------------------------------------------------------------------------
create or replace function public.guard_order_transition()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from old.status
     and not public.can_transition_order(old.status, new.status) then
    raise exception 'transição de status inválida: % -> %', old.status, new.status
      using errcode = 'check_violation';
  end if;

  -- Carimbos de tempo derivados do status, para não depender do chamador.
  if new.status = 'delivered' and new.delivered_at is null then
    new.delivered_at := now();
  end if;
  if new.status = 'canceled' and new.canceled_at is null then
    new.canceled_at := now();
  end if;
  if new.status <> 'draft' and new.placed_at is null then
    new.placed_at := now();
  end if;

  return new;
end;
$$;

create trigger orders_guard_transition
  before update of status on public.orders
  for each row execute function public.guard_order_transition();

create or replace function public.record_order_status_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.order_status_events (order_id, tenant_id, status, changed_by)
    values (new.id, new.tenant_id, new.status, auth.uid());
  end if;
  return null;
end;
$$;

create trigger orders_record_status_event
  after insert or update of status on public.orders
  for each row execute function public.record_order_status_event();

-- ------------------------------------ RLS ------------------------------------
alter table public.order_status_events enable row level security;

-- Mesma regra de visibilidade do pedido: o cliente vê a linha do tempo dos
-- próprios pedidos; o staff, a do próprio tenant.
create policy order_status_events_select on public.order_status_events
  for select to authenticated
  using (
    tenant_id = (select public.current_tenant_id())
    or exists (
      select 1
      from public.orders o
      join public.customers c on c.id = o.customer_id
      where o.id = order_id and c.auth_user_id = (select auth.uid())
    )
  );
-- Escrita: apenas pelo trigger (SECURITY DEFINER) e por service_role.

-- Realtime: o cliente acompanha sem refresh.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.order_status_events;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- advance_order_status(p_order_id uuid, p_status public.order_status, p_note text)
-- Contrato ESTÁVEL: -> jsonb { "ok": bool, "error": text|null, "status": text|null }
--   Avança o status de um pedido validando a transição. Restrito ao staff do
--   tenant dono do pedido; o cliente cancela pelo mesmo caminho apenas
--   enquanto o pedido não foi confirmado.
-- -----------------------------------------------------------------------------
create or replace function public.advance_order_status(
  p_order_id uuid,
  p_status   public.order_status,
  p_note     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order    public.orders%rowtype;
  v_is_staff boolean;
  v_is_owner boolean;
begin
  select * into v_order from public.orders where id = p_order_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'pedido_nao_encontrado', 'status', null);
  end if;

  -- coalesce obrigatório: current_tenant_id() é NULL para cliente B2C, e sem
  -- ele a comparação vira NULL, que anularia os dois testes de autorização
  -- abaixo (NOT NULL é NULL, então nenhum IF dispararia).
  v_is_staff := coalesce(v_order.tenant_id = public.current_tenant_id(), false);
  v_is_owner := exists (
    select 1 from public.customers c
    where c.id = v_order.customer_id and c.auth_user_id = auth.uid());

  if not v_is_staff and not v_is_owner then
    return jsonb_build_object('ok', false, 'error', 'nao_autorizado', 'status', null);
  end if;

  -- Cliente só pode cancelar, e só antes da confirmação.
  if not v_is_staff and (p_status <> 'canceled' or v_order.status not in ('draft', 'placed')) then
    return jsonb_build_object('ok', false, 'error', 'nao_autorizado', 'status', null);
  end if;

  if not public.can_transition_order(v_order.status, p_status) then
    return jsonb_build_object('ok', false, 'error', 'transicao_invalida',
                              'status', v_order.status::text);
  end if;

  update public.orders set status = p_status where id = p_order_id;

  if p_note is not null then
    update public.order_status_events set note = p_note
    where order_id = p_order_id and status = p_status
      and created_at = (select max(created_at) from public.order_status_events
                        where order_id = p_order_id);
  end if;

  return jsonb_build_object('ok', true, 'error', null, 'status', p_status::text);
end;
$$;

grant execute on function public.advance_order_status(uuid, public.order_status, text) to authenticated;
