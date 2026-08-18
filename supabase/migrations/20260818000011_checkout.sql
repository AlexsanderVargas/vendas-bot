-- =============================================================================
-- Migration: Checkout transacional
-- Fase 2 / PBI (issue #10) — Cardápio Digital e Delivery B2C
--
-- Toda a conversão carrinho -> pedido acontece em UMA função, por dois motivos:
--  1) atomicidade: pedido, itens e limpeza do carrinho num único commit;
--  2) confiança: preço, disponibilidade, regras de opcionais e taxa de entrega
--     são recalculados no servidor. O cliente envia apenas ids e quantidades.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- checkout_order(...)
-- Contrato ESTÁVEL:
--   (p_tenant_id uuid, p_customer_id uuid, p_channel public.order_channel,
--    p_items jsonb, p_address_id uuid, p_notes text) -> jsonb
--
-- p_items: [{ "productId": uuid, "quantity": number, "notes": text|null,
--             "optionIds": [uuid] }]
--
-- Saída (chaves fixas):
--   { "ok": bool, "error": text|null, "order": { "id", "orderNumber", "status",
--     "channel", "subtotal", "deliveryFee", "total", "etaMinutes" } | null }
--
-- error: 'estabelecimento_inativo' | 'carrinho_vazio' | 'produto_indisponivel'
--   | 'opcional_invalido' | 'opcionais_obrigatorios' | 'endereco_invalido'
--   | 'entrega_indisponivel:<motivo>' | 'nao_autorizado'
-- -----------------------------------------------------------------------------
create or replace function public.checkout_order(
  p_tenant_id   uuid,
  p_customer_id uuid,
  p_channel     public.order_channel,
  p_items       jsonb,
  p_address_id  uuid default null,
  p_notes       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant       public.tenants%rowtype;
  v_item         jsonb;
  v_product      public.products%rowtype;
  v_option_ids   uuid[];
  v_option_count integer;
  v_unit_price   numeric(12,2);
  v_extras       numeric(12,2);
  v_quantity     numeric(10,3);
  v_snapshot     jsonb;
  v_group        record;
  v_chosen       integer;
  v_subtotal     numeric(12,2) := 0;
  v_delivery_fee numeric(12,2) := 0;
  v_eta          integer;
  v_address      public.customer_addresses%rowtype;
  v_address_snap jsonb := null;
  v_quote        jsonb;
  v_order_id     uuid;
  v_order        public.orders%rowtype;
  v_lines        jsonb := '[]'::jsonb;
begin
  -- ------------------------------------------------------------------ acesso
  -- SECURITY DEFINER ignora RLS: a autorização é verificada explicitamente.
  if not exists (
    select 1 from public.customers c
    where c.id = p_customer_id
      and c.tenant_id = p_tenant_id
      and (c.auth_user_id = auth.uid() or c.tenant_id = public.current_tenant_id())
  ) then
    return jsonb_build_object('ok', false, 'error', 'nao_autorizado', 'order', null);
  end if;

  select * into v_tenant from public.tenants where id = p_tenant_id;
  if not found or not v_tenant.is_active then
    return jsonb_build_object('ok', false, 'error', 'estabelecimento_inativo', 'order', null);
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    return jsonb_build_object('ok', false, 'error', 'carrinho_vazio', 'order', null);
  end if;

  -- ------------------------------------------------- validação e precificação
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_quantity := (v_item->>'quantity')::numeric;
    if v_quantity is null or v_quantity <= 0 then
      return jsonb_build_object('ok', false, 'error', 'produto_indisponivel', 'order', null);
    end if;

    select * into v_product
    from public.products
    where id = (v_item->>'productId')::uuid
      and tenant_id = p_tenant_id
      and is_active
      and is_available;

    if not found then
      return jsonb_build_object('ok', false, 'error', 'produto_indisponivel', 'order', null);
    end if;

    v_option_ids := coalesce(
      (select array_agg(value::uuid) from jsonb_array_elements_text(coalesce(v_item->'optionIds', '[]'::jsonb))),
      '{}'::uuid[]);

    -- Só contam opções disponíveis, de grupos ativos DESTE produto.
    select count(*), coalesce(sum(po.price_delta), 0)
      into v_option_count, v_extras
    from public.product_options po
    join public.product_option_groups g on g.id = po.group_id
    where po.id = any(v_option_ids)
      and g.product_id = v_product.id
      and g.is_active
      and po.is_available;

    if v_option_count <> coalesce(array_length(v_option_ids, 1), 0) then
      return jsonb_build_object('ok', false, 'error', 'opcional_invalido', 'order', null);
    end if;

    -- Regras de min/max de cada grupo obrigatório.
    for v_group in
      select g.id, g.min_select, g.max_select
      from public.product_option_groups g
      where g.product_id = v_product.id and g.is_active
    loop
      select count(*) into v_chosen
      from public.product_options po
      where po.id = any(v_option_ids) and po.group_id = v_group.id;

      if v_chosen < v_group.min_select or v_chosen > v_group.max_select then
        return jsonb_build_object('ok', false, 'error', 'opcionais_obrigatorios', 'order', null);
      end if;
    end loop;

    v_unit_price := round(v_product.price + v_extras, 2);
    v_subtotal := v_subtotal + round(v_unit_price * v_quantity, 2);

    -- Snapshot dos opcionais escolhidos (nome e preço congelados).
    select coalesce(jsonb_agg(jsonb_build_object(
             'groupId', g.id, 'groupName', g.name,
             'optionId', po.id, 'optionName', po.name,
             'priceDelta', po.price_delta) order by g.sort_order, po.sort_order), '[]'::jsonb)
      into v_snapshot
    from public.product_options po
    join public.product_option_groups g on g.id = po.group_id
    where po.id = any(v_option_ids) and g.product_id = v_product.id;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'productId', v_product.id, 'productName', v_product.name,
      'unitPrice', v_unit_price, 'quantity', v_quantity,
      'notes', v_item->>'notes', 'selectedOptions', v_snapshot));
  end loop;

  -- ------------------------------------------------------------------ entrega
  if p_channel = 'delivery' then
    select * into v_address
    from public.customer_addresses
    where id = p_address_id and customer_id = p_customer_id;

    if not found then
      return jsonb_build_object('ok', false, 'error', 'endereco_invalido', 'order', null);
    end if;

    v_quote := public.quote_delivery(
      p_tenant_id, v_subtotal,
      extensions.ST_Y(v_address.location::extensions.geometry),
      extensions.ST_X(v_address.location::extensions.geometry),
      v_address.neighborhood, v_address.city);

    if not (v_quote->>'eligible')::boolean then
      return jsonb_build_object('ok', false,
        'error', 'entrega_indisponivel:' || coalesce(v_quote->>'reason', 'desconhecido'),
        'order', null);
    end if;

    v_delivery_fee := (v_quote->>'fee')::numeric;
    v_eta := (v_quote->>'eta_minutes')::integer;

    -- Snapshot imutável do endereço no momento do pedido.
    v_address_snap := jsonb_build_object(
      'label', v_address.label, 'street', v_address.street, 'number', v_address.number,
      'complement', v_address.complement, 'neighborhood', v_address.neighborhood,
      'city', v_address.city, 'state', v_address.state, 'zipCode', v_address.zip_code,
      'reference', v_address.reference);
  else
    v_eta := v_tenant.delivery_eta_minutes;
  end if;

  -- ------------------------------------------------------------------- pedido
  insert into public.orders (
    tenant_id, customer_id, channel, status, payment_status,
    delivery_address, delivery_address_id, subtotal, discount, delivery_fee, total, notes)
  values (
    p_tenant_id, p_customer_id, p_channel, 'placed', 'pending',
    v_address_snap, case when p_channel = 'delivery' then p_address_id end,
    v_subtotal, 0, v_delivery_fee, v_subtotal + v_delivery_fee, p_notes)
  returning id into v_order_id;

  insert into public.order_items (order_id, tenant_id, product_id, product_name,
                                  unit_price, quantity, notes, selected_options)
  select v_order_id, p_tenant_id, (line->>'productId')::uuid, line->>'productName',
         (line->>'unitPrice')::numeric, (line->>'quantity')::numeric,
         line->>'notes', line->'selectedOptions'
  from jsonb_array_elements(v_lines) as line;

  -- Carrinho cumpriu seu papel.
  delete from public.carts where tenant_id = p_tenant_id and customer_id = p_customer_id;

  select * into v_order from public.orders where id = v_order_id;

  return jsonb_build_object('ok', true, 'error', null, 'order', jsonb_build_object(
    'id', v_order.id, 'orderNumber', v_order.order_number, 'status', v_order.status,
    'channel', v_order.channel, 'subtotal', v_order.subtotal,
    'deliveryFee', v_order.delivery_fee, 'total', v_order.total, 'etaMinutes', v_eta));
end;
$$;

grant execute on function public.checkout_order(uuid, uuid, public.order_channel, jsonb, uuid, text)
  to authenticated;
