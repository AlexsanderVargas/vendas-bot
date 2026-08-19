-- =============================================================================
-- Estorno de estoque no cancelamento do pedido (issue #77)
--
-- `deduct_order_stock` baixa os insumos quando o pedido entra em produção e
-- marca `orders.stock_deducted_at`. Nenhum caminho de cancelamento desfazia
-- isso — nem o painel, nem o cliente, nem o cancelamento vindo do iFood.
--
-- O pão e a carne do pedido cancelado sumiam do estoque e não voltavam:
-- contagem física deixava de bater, alerta de mínimo disparava sem motivo e o
-- CMV do DRE inflava — cada cancelamento virava "custo" de comida que continua
-- na geladeira.
--
-- A devolução é POR LOTE, não por quantidade agregada: o custo unitário é do
-- lote, e devolver 2 kg ao lote errado desloca o CMV de todas as saídas
-- seguintes (FEFO consome o mais barato primeiro).
-- =============================================================================

alter table public.orders
  add column if not exists stock_restored_at timestamptz;

comment on column public.orders.stock_restored_at is
  'Quando os insumos baixados voltaram ao estoque. Impede estorno em duplicidade.';

-- -----------------------------------------------------------------------------
-- apply_stock_restore(p_order_id uuid) -> jsonb
--   { "ok": bool, "error": text|null, "restored": int, "quantity": numeric }
--
-- INTERNA e sem verificação de autorização: quem chama já provou o direito de
-- cancelar o pedido. Fica revogada de todo mundo justamente por isso — só
-- funções SECURITY DEFINER deste schema a alcançam.
-- -----------------------------------------------------------------------------
create or replace function public.apply_stock_restore(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order    public.orders%rowtype;
  v_movement record;
  v_count    integer := 0;
  v_total    numeric(14,3) := 0;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'pedido_nao_encontrado',
      'restored', 0, 'quantity', 0);
  end if;

  if v_order.stock_deducted_at is null then
    return jsonb_build_object('ok', true, 'error', 'nao_baixado', 'restored', 0, 'quantity', 0);
  end if;

  if v_order.stock_restored_at is not null then
    return jsonb_build_object('ok', true, 'error', 'ja_estornado', 'restored', 0, 'quantity', 0);
  end if;

  for v_movement in
    select id, ingredient_id, batch_id, quantity, unit_cost
    from public.stock_movements
    where order_id = p_order_id and type = 'out'
    order by created_at
  loop
    -- O lote pode ter sido apagado (batch_id vira null por ON DELETE SET NULL).
    -- Nesse caso o insumo recupera a quantidade, sem lote a que voltar.
    if v_movement.batch_id is not null then
      update public.stock_batches
      set quantity_remaining = quantity_remaining + v_movement.quantity
      where id = v_movement.batch_id;
    end if;

    insert into public.stock_movements (tenant_id, ingredient_id, batch_id, order_id,
                                        type, quantity, unit_cost, reason, created_by)
    values (v_order.tenant_id, v_movement.ingredient_id, v_movement.batch_id, p_order_id,
            'in', v_movement.quantity, v_movement.unit_cost,
            'Estorno do pedido nº ' || v_order.order_number || ' (cancelado)', auth.uid());

    update public.ingredients
    set stock_quantity = stock_quantity + v_movement.quantity
    where id = v_movement.ingredient_id;

    v_count := v_count + 1;
    v_total := v_total + v_movement.quantity;
  end loop;

  update public.orders set stock_restored_at = now() where id = p_order_id;

  return jsonb_build_object('ok', true, 'error', null, 'restored', v_count, 'quantity', v_total);
end;
$$;

revoke execute on function public.apply_stock_restore(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- restore_order_stock(p_order_id uuid)
-- Contrato ESTÁVEL: -> jsonb { "ok": bool, "error": text|null,
--                              "restored": int, "quantity": numeric }
--   Estorno manual, para o caso em que o pedido foi cancelado antes desta
--   migration existir. O caminho normal é o trigger.
--   error: 'pedido_nao_encontrado' | 'nao_autorizado' | 'nao_baixado'
--        | 'ja_estornado'
-- -----------------------------------------------------------------------------
create or replace function public.restore_order_stock(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  select tenant_id into v_tenant from public.orders where id = p_order_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'pedido_nao_encontrado',
      'restored', 0, 'quantity', 0);
  end if;

  if not public.can_access_tenant(v_tenant) then
    return jsonb_build_object('ok', false, 'error', 'nao_autorizado',
      'restored', 0, 'quantity', 0);
  end if;

  return public.apply_stock_restore(p_order_id);
end;
$$;

grant execute on function public.restore_order_stock(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- O estorno é TRIGGER, não chamada nas rotas.
--
-- Cancelamento chega hoje por três caminhos — painel, cliente e parceiro de
-- marketplace — e vai chegar por mais amanhã. Espalhar a chamada significa
-- que o próximo caminho vai esquecer dela, e o esquecimento é silencioso:
-- ninguém percebe estoque que não voltou.
-- -----------------------------------------------------------------------------
create or replace function public.restore_stock_on_cancel()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'canceled'
     and old.status is distinct from new.status
     and new.stock_deducted_at is not null
     and new.stock_restored_at is null then
    perform public.apply_stock_restore(new.id);
  end if;
  return null;
end;
$$;

-- `after update of status`: o próprio estorno escreve em stock_restored_at, e
-- essa escrita não redispara o trigger porque a coluna não está na lista.
create trigger orders_restore_stock_on_cancel
  after update of status on public.orders
  for each row execute function public.restore_stock_on_cancel();
