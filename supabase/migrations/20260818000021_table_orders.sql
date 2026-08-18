-- =============================================================================
-- Migration: Comandas de mesa e lançamento pelo garçom
-- Fase 4 / PBI (issue #23) — Organização do Estabelecimento
--
-- Uma comanda é um pedido com channel = 'dine_in' vinculado a uma mesa e
-- mantido aberto enquanto os clientes consomem.
-- =============================================================================

alter table public.orders
  add column table_id  uuid references public.dining_tables (id) on delete set null,
  add column waiter_id uuid references auth.users (id) on delete set null;

create index orders_table_open_idx on public.orders (table_id)
  where table_id is not null
    and status not in ('completed', 'canceled');

-- -----------------------------------------------------------------------------
-- recalc_order_totals()
-- Contrato: trigger AFTER INSERT/UPDATE/DELETE em order_items.
--   Mantém orders.subtotal e orders.total coerentes com os itens. Sem isso, a
--   comanda ficaria com o total do momento da abertura enquanto o garçom
--   continua lançando.
-- -----------------------------------------------------------------------------
create or replace function public.recalc_order_totals()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id uuid := coalesce(new.order_id, old.order_id);
  v_subtotal numeric(12,2);
begin
  select coalesce(sum(total), 0) into v_subtotal
  from public.order_items where order_id = v_order_id;

  update public.orders
  set subtotal = v_subtotal,
      total = v_subtotal - discount + delivery_fee
  where id = v_order_id;

  return null;
end;
$$;

create trigger order_items_recalc_totals
  after insert or update of unit_price, quantity or delete on public.order_items
  for each row execute function public.recalc_order_totals();

-- -----------------------------------------------------------------------------
-- open_table_order(p_table_id uuid, p_notes text)
-- Contrato ESTÁVEL: -> jsonb { "ok": bool, "error": text|null, "orderId": uuid|null,
--   "orderNumber": bigint|null }
--   error: 'mesa_nao_encontrada' | 'nao_autorizado' | 'mesa_indisponivel'
--        | 'comanda_ja_aberta'
--   Abre a comanda e marca a mesa como ocupada, no mesmo commit.
-- -----------------------------------------------------------------------------
create or replace function public.open_table_order(
  p_table_id uuid,
  p_notes    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table    public.dining_tables%rowtype;
  v_order_id uuid;
  v_number   bigint;
begin
  select * into v_table from public.dining_tables where id = p_table_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'mesa_nao_encontrada',
      'orderId', null, 'orderNumber', null);
  end if;

  if coalesce(v_table.tenant_id = public.current_tenant_id(), false) is false then
    return jsonb_build_object('ok', false, 'error', 'nao_autorizado',
      'orderId', null, 'orderNumber', null);
  end if;

  if v_table.status = 'inactive' then
    return jsonb_build_object('ok', false, 'error', 'mesa_indisponivel',
      'orderId', null, 'orderNumber', null);
  end if;

  if exists (
    select 1 from public.orders
    where table_id = p_table_id and status not in ('completed', 'canceled')
  ) then
    return jsonb_build_object('ok', false, 'error', 'comanda_ja_aberta',
      'orderId', null, 'orderNumber', null);
  end if;

  insert into public.orders (tenant_id, channel, status, payment_status,
                             table_id, waiter_id, subtotal, total, notes)
  values (v_table.tenant_id, 'dine_in', 'placed', 'pending',
          p_table_id, auth.uid(), 0, 0, p_notes)
  returning id, order_number into v_order_id, v_number;

  if v_table.status <> 'occupied' then
    update public.dining_tables set status = 'occupied' where id = p_table_id;
  end if;

  return jsonb_build_object('ok', true, 'error', null,
    'orderId', v_order_id, 'orderNumber', v_number);
end;
$$;

-- -----------------------------------------------------------------------------
-- add_order_item(p_order_id uuid, p_product_id uuid, p_quantity numeric,
--                p_option_ids uuid[], p_notes text)
-- Contrato ESTÁVEL: -> jsonb { "ok": bool, "error": text|null, "itemId": uuid|null,
--   "unitPrice": numeric|null, "orderTotal": numeric|null }
--   error: 'pedido_nao_encontrado' | 'nao_autorizado' | 'pedido_fechado'
--        | 'produto_indisponivel' | 'opcional_invalido' | 'opcionais_obrigatorios'
--
--   Mesmas validações do checkout: o preço vem do banco, nunca do cliente.
-- -----------------------------------------------------------------------------
create or replace function public.add_order_item(
  p_order_id   uuid,
  p_product_id uuid,
  p_quantity   numeric,
  p_option_ids uuid[] default '{}',
  p_notes      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order    public.orders%rowtype;
  v_product  public.products%rowtype;
  v_count    integer;
  v_extras   numeric(12,2);
  v_group    record;
  v_chosen   integer;
  v_price    numeric(12,2);
  v_snapshot jsonb;
  v_item_id  uuid;
  v_total    numeric(12,2);
begin
  select * into v_order from public.orders where id = p_order_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'pedido_nao_encontrado',
      'itemId', null, 'unitPrice', null, 'orderTotal', null);
  end if;

  if coalesce(v_order.tenant_id = public.current_tenant_id(), false) is false then
    return jsonb_build_object('ok', false, 'error', 'nao_autorizado',
      'itemId', null, 'unitPrice', null, 'orderTotal', null);
  end if;

  if v_order.status in ('completed', 'canceled') then
    return jsonb_build_object('ok', false, 'error', 'pedido_fechado',
      'itemId', null, 'unitPrice', null, 'orderTotal', null);
  end if;

  select * into v_product from public.products
  where id = p_product_id and tenant_id = v_order.tenant_id and is_active and is_available;
  if not found or p_quantity is null or p_quantity <= 0 then
    return jsonb_build_object('ok', false, 'error', 'produto_indisponivel',
      'itemId', null, 'unitPrice', null, 'orderTotal', null);
  end if;

  select count(*), coalesce(sum(po.price_delta), 0) into v_count, v_extras
  from public.product_options po
  join public.product_option_groups g on g.id = po.group_id
  where po.id = any(coalesce(p_option_ids, '{}'))
    and g.product_id = v_product.id and g.is_active and po.is_available;

  if v_count <> coalesce(array_length(p_option_ids, 1), 0) then
    return jsonb_build_object('ok', false, 'error', 'opcional_invalido',
      'itemId', null, 'unitPrice', null, 'orderTotal', null);
  end if;

  for v_group in
    select g.id, g.min_select, g.max_select
    from public.product_option_groups g
    where g.product_id = v_product.id and g.is_active
  loop
    select count(*) into v_chosen from public.product_options po
    where po.id = any(coalesce(p_option_ids, '{}')) and po.group_id = v_group.id;

    if v_chosen < v_group.min_select or v_chosen > v_group.max_select then
      return jsonb_build_object('ok', false, 'error', 'opcionais_obrigatorios',
        'itemId', null, 'unitPrice', null, 'orderTotal', null);
    end if;
  end loop;

  v_price := round(v_product.price + v_extras, 2);

  select coalesce(jsonb_agg(jsonb_build_object(
           'groupId', g.id, 'groupName', g.name,
           'optionId', po.id, 'optionName', po.name,
           'priceDelta', po.price_delta) order by g.sort_order, po.sort_order), '[]'::jsonb)
    into v_snapshot
  from public.product_options po
  join public.product_option_groups g on g.id = po.group_id
  where po.id = any(coalesce(p_option_ids, '{}')) and g.product_id = v_product.id;

  insert into public.order_items (order_id, tenant_id, product_id, product_name,
                                  unit_price, quantity, notes, selected_options)
  values (p_order_id, v_order.tenant_id, v_product.id, v_product.name,
          v_price, p_quantity, p_notes, v_snapshot)
  returning id into v_item_id;

  select total into v_total from public.orders where id = p_order_id;

  return jsonb_build_object('ok', true, 'error', null, 'itemId', v_item_id,
    'unitPrice', v_price, 'orderTotal', v_total);
end;
$$;

-- -----------------------------------------------------------------------------
-- close_table_order(p_order_id uuid)
-- Contrato ESTÁVEL: -> jsonb { "ok": bool, "error": text|null, "total": numeric|null }
--   Coloca a mesa em 'billing'. O encerramento financeiro é do módulo de caixa.
-- -----------------------------------------------------------------------------
create or replace function public.close_table_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
begin
  select * into v_order from public.orders where id = p_order_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'pedido_nao_encontrado', 'total', null);
  end if;

  if coalesce(v_order.tenant_id = public.current_tenant_id(), false) is false then
    return jsonb_build_object('ok', false, 'error', 'nao_autorizado', 'total', null);
  end if;

  if v_order.table_id is not null then
    update public.dining_tables set status = 'billing'
    where id = v_order.table_id and status = 'occupied';
  end if;

  return jsonb_build_object('ok', true, 'error', null, 'total', v_order.total);
end;
$$;

grant execute on function public.open_table_order(uuid, text) to authenticated;
grant execute on function public.add_order_item(uuid, uuid, numeric, uuid[], text) to authenticated;
grant execute on function public.close_table_order(uuid) to authenticated;
