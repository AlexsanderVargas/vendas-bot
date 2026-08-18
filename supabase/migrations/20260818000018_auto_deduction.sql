-- =============================================================================
-- Migration: Baixa automática pela ficha técnica e alertas de estoque
-- Fase 3 / PBI (issue #18) — Gestão de Produtos e Insumos
-- =============================================================================

-- Marca de idempotência: garante uma única baixa por pedido, mesmo que o
-- status oscile ou o gatilho dispare novamente.
alter table public.orders
  add column stock_deducted_at timestamptz;

-- -----------------------------------------------------------------------------
-- deduct_order_stock(p_order_id uuid)
-- Contrato ESTÁVEL: (uuid) -> jsonb
--   { "ok": bool, "error": text|null, "deducted": int, "shortages":
--     [{ "ingredientId": uuid, "ingredientName": text, "requested": numeric,
--        "consumed": numeric }] }
--
--   Consome os insumos de todos os itens do pedido conforme a ficha técnica,
--   multiplicando pela quantidade vendida e embutindo a perda de preparo.
--   Itens sem ficha técnica são ignorados (produto revendido, sem produção).
--   A falta de estoque NÃO impede a venda: registra o que saiu e devolve as
--   faltas, para o gestor decidir. error: 'pedido_nao_encontrado' | 'ja_baixado'
-- -----------------------------------------------------------------------------
create or replace function public.deduct_order_stock(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order     public.orders%rowtype;
  v_line      record;
  v_result    jsonb;
  v_needed    numeric(14,4);
  v_count     integer := 0;
  v_shortages jsonb := '[]'::jsonb;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'pedido_nao_encontrado',
      'deducted', 0, 'shortages', v_shortages);
  end if;

  if v_order.stock_deducted_at is not null then
    return jsonb_build_object('ok', true, 'error', 'ja_baixado',
      'deducted', 0, 'shortages', v_shortages);
  end if;

  -- Agrega por insumo: o mesmo insumo pode aparecer em vários itens do pedido.
  for v_line in
    select r.ingredient_id,
           i.name as ingredient_name,
           sum(public.recipe_effective_quantity(r.quantity, r.waste_percent) * oi.quantity) as needed
    from public.order_items oi
    join public.product_recipes r on r.product_id = oi.product_id
    join public.ingredients i on i.id = r.ingredient_id
    where oi.order_id = p_order_id
    group by r.ingredient_id, i.name
  loop
    v_needed := round(v_line.needed, 4);
    v_result := public.consume_stock(
      v_line.ingredient_id, v_needed, 'out',
      'Baixa automática do pedido nº ' || v_order.order_number, p_order_id);

    v_count := v_count + 1;

    if (v_result->>'error') = 'estoque_insuficiente' then
      v_shortages := v_shortages || jsonb_build_array(jsonb_build_object(
        'ingredientId', v_line.ingredient_id,
        'ingredientName', v_line.ingredient_name,
        'requested', v_needed,
        'consumed', (v_result->>'consumed')::numeric));
    end if;
  end loop;

  update public.orders set stock_deducted_at = now() where id = p_order_id;

  return jsonb_build_object('ok', true, 'error', null,
    'deducted', v_count, 'shortages', v_shortages);
end;
$$;

-- -----------------------------------------------------------------------------
-- Gatilho: baixa quando o pedido é confirmado pelo estabelecimento.
-- 'confirmed' e não 'placed' de propósito — pedido ainda não aceito pode ser
-- recusado, e baixar antes disso devolveria estoque errado.
-- Contrato: trigger AFTER UPDATE OF status em orders.
-- -----------------------------------------------------------------------------
create or replace function public.auto_deduct_order_stock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'confirmed' and old.status is distinct from 'confirmed'
     and new.stock_deducted_at is null then
    perform public.deduct_order_stock(new.id);
  end if;
  return null;
end;
$$;

create trigger orders_auto_deduct_stock
  after update of status on public.orders
  for each row execute function public.auto_deduct_order_stock();

-- -----------------------------------------------------------------------------
-- stock_alerts(p_tenant_id uuid, p_expiring_days integer)
-- Contrato ESTÁVEL: -> setof (kind text, ingredient_id uuid, ingredient_name text,
--   base_unit public.unit_of_measure, quantity numeric, threshold numeric,
--   expires_at date, batch_code text)
--   kind: 'below_minimum' | 'expiring' | 'expired'
-- -----------------------------------------------------------------------------
create or replace function public.stock_alerts(
  p_tenant_id      uuid,
  p_expiring_days  integer default 7
)
returns table (
  kind            text,
  ingredient_id   uuid,
  ingredient_name text,
  base_unit       public.unit_of_measure,
  quantity        numeric,
  threshold       numeric,
  expires_at      date,
  batch_code      text
)
language sql
stable
security definer
set search_path = ''
as $$
  select 'below_minimum'::text, i.id, i.name, i.base_unit,
         i.stock_quantity, i.minimum_stock, null::date, null::text
  from public.ingredients i
  where i.tenant_id = p_tenant_id and i.is_active
    and i.stock_quantity <= i.minimum_stock

  union all

  select case when b.expires_at < current_date then 'expired' else 'expiring' end,
         i.id, i.name, i.base_unit,
         b.quantity_remaining, null::numeric, b.expires_at, b.batch_code
  from public.stock_batches b
  join public.ingredients i on i.id = b.ingredient_id
  where b.tenant_id = p_tenant_id
    and b.quantity_remaining > 0
    and b.expires_at is not null
    and b.expires_at <= current_date + p_expiring_days

  order by 1, 3;
$$;

grant execute on function public.deduct_order_stock(uuid) to authenticated;
grant execute on function public.stock_alerts(uuid, integer) to authenticated;
