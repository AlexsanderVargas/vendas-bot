-- =============================================================================
-- Marketplace: não perder pedido e acompanhar o cancelamento do parceiro.
--
-- Problema 1 — pedido perdido para sempre. `record_integration_event` marca
-- como `duplicated` todo evento JÁ REGISTRADO. Mas o registro acontece antes
-- da ingestão: se o `fetchOrder` falhar (parceiro fora do ar, timeout), o
-- evento fica registrado, sem `processed_at`, e o pedido não entra. Na
-- reentrega, o mesmo evento volta como "duplicado", é confirmado no parceiro
-- e nunca mais é reprocessado — o pedido desaparece silenciosamente.
--
-- Correção: distinguir REGISTRADO de PROCESSADO. O jsonb ganha o campo
-- `processed`; quem decide ignorar o evento é ele, não `duplicated`. Campo
-- ADITIVO — quem lê `ok`/`duplicated`/`eventId` continua funcionando. De
-- quebra, `eventId` passa a vir preenchido também no caminho duplicado, onde
-- antes era sempre null.
--
-- Problema 2 — cancelamento não propaga. O canal avisa que o cliente cancelou
-- no app do iFood, e o pedido interno segue 'confirmed'/'preparing': a cozinha
-- produz um pedido morto e o DRE pode contá-lo. Faltava função que cancelasse
-- o pedido a partir da referência externa. `cancel_external_order` é contrato
-- NOVO — nada existente muda.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- record_integration_event(...) -> jsonb
-- Contrato: { ok, duplicated, processed, eventId }
--   `duplicated` = o evento já havia sido registrado.
--   `processed`  = o evento já foi processado COM SUCESSO (processed_at).
--   Só o segundo autoriza ignorar o evento e confirmá-lo no parceiro.
-- -----------------------------------------------------------------------------
create or replace function public.record_integration_event(
  p_integration_id    uuid,
  p_event_id          text,
  p_code              text,
  p_external_order_id text default null,
  p_payload           jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id        uuid;
  v_processed timestamptz;
begin
  insert into public.integration_events
    (integration_id, external_event_id, event_code, external_order_id, payload)
  values (p_integration_id, p_event_id, p_code, p_external_order_id, p_payload)
  on conflict (integration_id, external_event_id) do nothing
  returning id into v_id;

  if v_id is not null then
    return jsonb_build_object(
      'ok', true, 'duplicated', false, 'processed', false, 'eventId', v_id);
  end if;

  -- Já registrado: o que decide se pode ser ignorado é ter sido processado.
  select id, processed_at into v_id, v_processed
  from public.integration_events
  where integration_id = p_integration_id
    and external_event_id = p_event_id;

  return jsonb_build_object(
    'ok', true,
    'duplicated', true,
    'processed', v_processed is not null,
    'eventId', v_id);
end;
$$;

-- -----------------------------------------------------------------------------
-- cancel_external_order(p_integration_id, p_external_order_id, p_reason) -> jsonb
-- Contrato NOVO: { ok, error, orderId }
--   error: null | 'integracao_nao_encontrada' | 'nao_autorizado'
--        | 'pedido_nao_encontrado' | 'ja_cancelado' | 'transicao_invalida'
--
-- Cancela o pedido interno correspondente ao pedido do parceiro. Idempotente:
-- pedido já cancelado devolve ok=true, porque a reentrega do mesmo evento não
-- pode virar erro e travar a fila.
-- -----------------------------------------------------------------------------
create or replace function public.cancel_external_order(
  p_integration_id    uuid,
  p_external_order_id text,
  p_reason            text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_order  public.orders%rowtype;
begin
  select tenant_id into v_tenant
  from public.integrations
  where id = p_integration_id;

  if v_tenant is null then
    return jsonb_build_object('ok', false, 'error', 'integracao_nao_encontrada', 'orderId', null);
  end if;

  if not public.can_access_tenant(v_tenant) then
    return jsonb_build_object('ok', false, 'error', 'nao_autorizado', 'orderId', null);
  end if;

  -- FOR UPDATE serializa contra o avanço de status feito pela operação.
  select * into v_order
  from public.orders
  where tenant_id = v_tenant
    and external_order_id = p_external_order_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'pedido_nao_encontrado', 'orderId', null);
  end if;

  if v_order.status = 'canceled' then
    return jsonb_build_object('ok', true, 'error', 'ja_cancelado', 'orderId', v_order.id);
  end if;

  -- Pedido entregue ou concluído não volta atrás: o cancelamento tardio do
  -- parceiro vira divergência para a operação resolver, não um estado impossível.
  if not public.can_transition_order(v_order.status, 'canceled') then
    return jsonb_build_object('ok', false, 'error', 'transicao_invalida', 'orderId', v_order.id);
  end if;

  -- O trigger guard_order_transition valida a transição e carimba canceled_at;
  -- record_order_status_event registra o evento na linha do tempo.
  update public.orders
  set status = 'canceled',
      notes = case
        when p_reason is null or p_reason = '' then notes
        when notes is null or notes = '' then 'Cancelado pelo parceiro: ' || p_reason
        else notes || E'\n' || 'Cancelado pelo parceiro: ' || p_reason
      end
  where id = v_order.id;

  return jsonb_build_object('ok', true, 'error', null, 'orderId', v_order.id);
end;
$$;

revoke execute on function public.cancel_external_order(uuid, text, text) from public;
grant execute on function public.cancel_external_order(uuid, text, text) to authenticated, service_role;
