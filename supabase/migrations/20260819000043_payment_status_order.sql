-- =============================================================================
-- Webhook atrasado não rebaixa mais o status do pagamento (issue #80)
--
-- `apply_payment_status` aplicava qualquer status que chegasse:
--
--     update public.payments set status = p_status, raw = p_payload ...
--
-- Gateways não garantem ordem de entrega. O Mercado Pago manda `pending` e
-- `approved` quase juntos; uma reentrega ou uma fila mais lenta faz o
-- `pending` chegar depois. O pedido pago voltava para "aguardando pagamento"
-- na tela do cliente e na do caixa. Pior: depois de um estorno, um `approved`
-- atrasado marcava como pago um pedido cujo dinheiro já tinha voltado.
--
-- A idempotência por `provider_event_id` não cobria isso — são eventos
-- DIFERENTES, cada um com seu id, chegando fora de ordem.
--
-- O evento fora de ordem continua sendo registrado e marcado como processado:
-- ele não é lixo, é prova do que o gateway mandou. Só não altera mais nada.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- payment_status_rank(status)
-- Contrato: (payment_intent_status) -> integer
--   Posição do status na vida da cobrança. Só se avança:
--     0 pending  →  1 processing  →  2 desfecho  →  3 refunded
--   Os desfechos (approved, rejected, canceled, expired) empatam de propósito:
--   nenhum deles vira outro. De approved só se sai para refunded, que é o
--   único caminho legítimo depois que o dinheiro entrou.
-- -----------------------------------------------------------------------------
create or replace function public.payment_status_rank(p_status public.payment_intent_status)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_status
    when 'pending'    then 0
    when 'processing' then 1
    when 'approved'   then 2
    when 'rejected'   then 2
    when 'canceled'   then 2
    when 'expired'    then 2
    when 'refunded'   then 3
  end;
$$;

grant execute on function public.payment_status_rank(public.payment_intent_status)
  to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- apply_payment_status(...)
-- Contrato ESTÁVEL (inalterado): -> jsonb
--   { "ok": bool, "error": text|null, "duplicated": bool, "paymentId": uuid|null,
--     "orderPaymentStatus": text|null }
--   error: 'pagamento_nao_encontrado'
--
--   `orderPaymentStatus` passa a devolver o status que DE FATO vale para o
--   pedido — que, no caso do evento fora de ordem, é o que já estava lá.
-- -----------------------------------------------------------------------------
create or replace function public.apply_payment_status(
  p_provider            public.payment_provider,
  p_provider_payment_id text,
  p_status              public.payment_intent_status,
  p_event_id            text,
  p_event_type          text default 'payment.updated',
  p_payload             jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment public.payments%rowtype;
  v_order_status public.payment_status;
  v_inserted boolean;
begin
  select * into v_payment from public.payments
  where provider = p_provider and provider_payment_id = p_provider_payment_id
  for update;

  if not found then
    -- Registra mesmo assim: notificação órfã ajuda a diagnosticar.
    insert into public.payment_events (provider, provider_event_id, event_type, payload)
    values (p_provider, p_event_id, p_event_type, p_payload)
    on conflict (provider, provider_event_id) do nothing;

    return jsonb_build_object('ok', false, 'error', 'pagamento_nao_encontrado',
      'duplicated', false, 'paymentId', null, 'orderPaymentStatus', null);
  end if;

  insert into public.payment_events (payment_id, provider, provider_event_id, event_type, payload)
  values (v_payment.id, p_provider, p_event_id, p_event_type, p_payload)
  on conflict (provider, provider_event_id) do nothing;

  v_inserted := found;

  if not v_inserted then
    -- Reenvio do mesmo evento: nada a aplicar.
    return jsonb_build_object('ok', true, 'error', null, 'duplicated', true,
      'paymentId', v_payment.id, 'orderPaymentStatus', null);
  end if;

  -- Evento que não avança a cobrança fica registrado e encerrado, sem tocar
  -- em nada. Devolver erro faria o gateway reenviar para sempre um evento que
  -- está correto — só chegou tarde.
  if public.payment_status_rank(p_status)
     <= public.payment_status_rank(v_payment.status) then

    update public.payment_events set processed_at = now()
    where provider = p_provider and provider_event_id = p_event_id;

    select o.payment_status into v_order_status
    from public.orders o where o.id = v_payment.order_id;

    return jsonb_build_object('ok', true, 'error', null, 'duplicated', false,
      'paymentId', v_payment.id, 'orderPaymentStatus', v_order_status::text);
  end if;

  update public.payments set status = p_status, raw = p_payload
  where id = v_payment.id;

  v_order_status := case p_status
    when 'approved' then 'paid'
    when 'refunded' then 'refunded'
    when 'rejected' then 'failed'
    when 'expired'  then 'failed'
    when 'canceled' then 'failed'
    else 'pending'
  end;

  update public.orders set payment_status = v_order_status where id = v_payment.order_id;

  update public.payment_events set processed_at = now()
  where provider = p_provider and provider_event_id = p_event_id;

  return jsonb_build_object('ok', true, 'error', null, 'duplicated', false,
    'paymentId', v_payment.id, 'orderPaymentStatus', v_order_status::text);
end;
$$;
