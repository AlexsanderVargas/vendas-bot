-- =============================================================================
-- Migration: Fila de emissão fiscal, contingência e cancelamento
-- Fase 6 / PBI (issue #34) — Fiscal e Tributário
-- =============================================================================

alter table public.fiscal_settings
  -- Prazo legal de cancelamento, em minutos, por modelo. O padrão reflete a
  -- regra mais comum (30 min para NFC-e, 24 h para NF-e), mas varia por
  -- estado — por isso é configurável e não fixo no código.
  add column nfce_cancel_window_minutes integer not null default 30
    constraint fiscal_nfce_window_positive check (nfce_cancel_window_minutes > 0),
  add column nfe_cancel_window_minutes integer not null default 1440
    constraint fiscal_nfe_window_positive check (nfe_cancel_window_minutes > 0),
  add column max_emission_attempts integer not null default 5
    constraint fiscal_max_attempts_positive check (max_emission_attempts > 0);

-- -----------------------------------------------------------------------------
-- next_fiscal_number(p_tenant_id uuid, p_model, p_series integer)
-- Contrato ESTÁVEL: -> bigint
--   Numeração sequencial por (tenant, modelo, série), sobre tenant_counters do
--   PBI 1. Numeração fiscal não pode ter buraco nem repetição.
-- -----------------------------------------------------------------------------
create or replace function public.next_fiscal_number(
  p_tenant_id uuid,
  p_model     public.fiscal_document_model,
  p_series    integer
)
returns bigint
language sql
security definer
set search_path = ''
as $$
  insert into public.tenant_counters as tc (tenant_id, key, value)
  values (p_tenant_id, 'fiscal:' || p_model::text || ':' || p_series, 1)
  on conflict (tenant_id, key) do update set value = tc.value + 1
  returning tc.value;
$$;

revoke execute on function public.next_fiscal_number(uuid, public.fiscal_document_model, integer)
  from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- build_fiscal_payload(p_order_id uuid, p_model)
-- Contrato ESTÁVEL: -> jsonb
--   Monta o conteúdo do documento a partir do pedido, resolvendo a tributação
--   de cada item. Estrutura própria (não o XML): o adapter de emissão traduz
--   para o layout do emissor escolhido.
--   { "order": {...}, "emitter": {...}, "items": [...], "totals": {...},
--     "missingTaxProfile": [uuid] }
-- -----------------------------------------------------------------------------
create or replace function public.build_fiscal_payload(
  p_order_id uuid,
  p_model    public.fiscal_document_model default 'nfce'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_order   public.orders%rowtype;
  v_tenant  public.tenants%rowtype;
  v_items   jsonb := '[]'::jsonb;
  v_missing jsonb := '[]'::jsonb;
  v_item    record;
  v_profile jsonb;
  v_taxes   numeric(12,2) := 0;
begin
  select * into v_order from public.orders where id = p_order_id;
  if not found then
    return jsonb_build_object('error', 'pedido_nao_encontrado');
  end if;

  select * into v_tenant from public.tenants where id = v_order.tenant_id;

  for v_item in
    select oi.id, oi.product_id, oi.product_name, oi.quantity, oi.unit_price, oi.total
    from public.order_items oi
    where oi.order_id = p_order_id
  loop
    v_profile := public.resolve_tax_profile(v_item.product_id);

    if (v_profile->>'source') = 'none' then
      v_missing := v_missing || to_jsonb(v_item.product_id);
    else
      v_taxes := v_taxes + round(v_item.total * coalesce((v_profile->>'icmsRate')::numeric, 0) / 100.0, 2);
    end if;

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'itemId', v_item.id,
      'productId', v_item.product_id,
      'description', v_item.product_name,
      'quantity', v_item.quantity,
      'unitPrice', v_item.unit_price,
      'total', v_item.total,
      'tax', v_profile));
  end loop;

  return jsonb_build_object(
    'model', p_model::text,
    'order', jsonb_build_object(
      'id', v_order.id, 'number', v_order.order_number,
      'channel', v_order.channel::text, 'total', v_order.total,
      'subtotal', v_order.subtotal, 'discount', v_order.discount,
      'deliveryFee', v_order.delivery_fee),
    'emitter', jsonb_build_object(
      'name', v_tenant.name, 'document', v_tenant.document,
      'street', v_tenant.address_street, 'number', v_tenant.address_number,
      'neighborhood', v_tenant.neighborhood, 'city', v_tenant.city,
      'state', v_tenant.state, 'zipCode', v_tenant.zip_code),
    'items', v_items,
    'totals', jsonb_build_object('amount', v_order.total, 'taxes', v_taxes),
    'missingTaxProfile', v_missing);
end;
$$;

-- -----------------------------------------------------------------------------
-- enqueue_fiscal_document(p_order_id uuid, p_model, p_contingency boolean)
-- Contrato ESTÁVEL: -> jsonb { "ok": bool, "error": text|null,
--   "documentId": uuid|null, "number": bigint|null, "status": text|null }
--   error: 'pedido_nao_encontrado' | 'nao_autorizado' | 'fiscal_desabilitado'
--        | 'pedido_nao_concluido' | 'documento_ja_existe' | 'tributacao_ausente'
--
--   Em contingência, o documento já nasce numerado e marcado como
--   'contingency': a venda não pode parar porque a SEFAZ caiu.
-- -----------------------------------------------------------------------------
create or replace function public.enqueue_fiscal_document(
  p_order_id    uuid,
  p_model       public.fiscal_document_model default 'nfce',
  p_contingency boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order    public.orders%rowtype;
  v_settings public.fiscal_settings%rowtype;
  v_payload  jsonb;
  v_series   integer;
  v_number   bigint;
  v_doc_id   uuid;
  v_status   public.fiscal_document_status;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'pedido_nao_encontrado',
      'documentId', null, 'number', null, 'status', null);
  end if;

  if coalesce(v_order.tenant_id = public.current_tenant_id(), false) is false then
    return jsonb_build_object('ok', false, 'error', 'nao_autorizado',
      'documentId', null, 'number', null, 'status', null);
  end if;

  select * into v_settings from public.fiscal_settings where tenant_id = v_order.tenant_id;
  if not found or not v_settings.is_enabled then
    return jsonb_build_object('ok', false, 'error', 'fiscal_desabilitado',
      'documentId', null, 'number', null, 'status', null);
  end if;

  if v_order.status not in ('delivered', 'completed') then
    return jsonb_build_object('ok', false, 'error', 'pedido_nao_concluido',
      'documentId', null, 'number', null, 'status', null);
  end if;

  -- Documento cancelado ou rejeitado pode ser reemitido; autorizado, não.
  if exists (select 1 from public.fiscal_documents
             where order_id = p_order_id
               and status in ('draft', 'queued', 'transmitting', 'authorized', 'contingency')) then
    return jsonb_build_object('ok', false, 'error', 'documento_ja_existe',
      'documentId', null, 'number', null, 'status', null);
  end if;

  v_payload := public.build_fiscal_payload(p_order_id, p_model);

  if jsonb_array_length(v_payload->'missingTaxProfile') > 0 then
    return jsonb_build_object('ok', false, 'error', 'tributacao_ausente',
      'documentId', null, 'number', null, 'status', null);
  end if;

  v_series := case when p_model = 'nfce' then v_settings.nfce_series else v_settings.nfe_series end;
  v_status := case when p_contingency then 'contingency' else 'queued' end;

  -- Em contingência o número sai na hora; na fila normal, só na autorização,
  -- para não queimar numeração em tentativa que será rejeitada.
  v_number := case when p_contingency
                   then public.next_fiscal_number(v_order.tenant_id, p_model, v_series)
                   else null end;

  insert into public.fiscal_documents
    (tenant_id, order_id, model, status, environment, series, number,
     total_amount, total_taxes, request_payload, next_attempt_at)
  values (v_order.tenant_id, p_order_id, p_model, v_status, v_settings.environment,
          v_series, v_number, v_order.total,
          (v_payload->'totals'->>'taxes')::numeric, v_payload, now())
  returning id into v_doc_id;

  return jsonb_build_object('ok', true, 'error', null, 'documentId', v_doc_id,
    'number', v_number, 'status', v_status::text);
end;
$$;

-- -----------------------------------------------------------------------------
-- mark_fiscal_result(...)
-- Contrato ESTÁVEL: (p_document_id uuid, p_status public.fiscal_document_status,
--   p_access_key text, p_protocol text, p_rejection_code text,
--   p_rejection_reason text, p_response jsonb, p_xml text, p_danfe_url text)
--   -> jsonb { "ok": bool, "error": text|null, "status": text|null,
--     "number": bigint|null, "willRetry": bool }
--
--   Aplica o retorno do emissor. Em rejeição, agenda nova tentativa com
--   backoff exponencial até o limite configurado; esgotado, para de tentar.
--   A numeração só é consumida quando o documento é efetivamente autorizado.
-- -----------------------------------------------------------------------------
create or replace function public.mark_fiscal_result(
  p_document_id     uuid,
  p_status          public.fiscal_document_status,
  p_access_key      text default null,
  p_protocol        text default null,
  p_rejection_code  text default null,
  p_rejection_reason text default null,
  p_response        jsonb default '{}'::jsonb,
  p_xml             text default null,
  p_danfe_url       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc      public.fiscal_documents%rowtype;
  v_settings public.fiscal_settings%rowtype;
  v_attempts integer;
  v_retry    boolean := false;
  v_number   bigint;
begin
  select * into v_doc from public.fiscal_documents where id = p_document_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'documento_nao_encontrado',
      'status', null, 'number', null, 'willRetry', false);
  end if;

  select * into v_settings from public.fiscal_settings where tenant_id = v_doc.tenant_id;
  v_attempts := v_doc.attempts + 1;
  v_number := v_doc.number;

  if p_status = 'authorized' then
    if p_access_key is null or p_protocol is null then
      return jsonb_build_object('ok', false, 'error', 'retorno_incompleto',
        'status', v_doc.status::text, 'number', v_number, 'willRetry', false);
    end if;

    if v_number is null then
      v_number := public.next_fiscal_number(v_doc.tenant_id, v_doc.model, v_doc.series);
    end if;

    update public.fiscal_documents
    set status = 'authorized', number = v_number, access_key = p_access_key,
        protocol = p_protocol, authorized_at = now(), attempts = v_attempts,
        response_payload = p_response, xml = p_xml, danfe_url = p_danfe_url,
        next_attempt_at = null, rejection_code = null, rejection_reason = null
    where id = p_document_id;

  elsif p_status = 'rejected' then
    v_retry := v_attempts < coalesce(v_settings.max_emission_attempts, 5);

    update public.fiscal_documents
    set status = (case when v_retry then 'queued' else 'rejected' end)::public.fiscal_document_status,
        attempts = v_attempts, rejection_code = p_rejection_code,
        rejection_reason = p_rejection_reason, response_payload = p_response,
        -- Backoff exponencial: 1, 2, 4, 8... minutos.
        next_attempt_at = case when v_retry
                               then now() + (power(2, v_attempts - 1) || ' minutes')::interval
                               else null end
    where id = p_document_id;

  else
    update public.fiscal_documents
    set status = p_status, attempts = v_attempts, response_payload = p_response,
        rejection_code = p_rejection_code, rejection_reason = p_rejection_reason,
        next_attempt_at = null
    where id = p_document_id;
  end if;

  return jsonb_build_object('ok', true, 'error', null,
    'status', (select status::text from public.fiscal_documents where id = p_document_id),
    'number', v_number, 'willRetry', v_retry);
end;
$$;

-- -----------------------------------------------------------------------------
-- cancel_fiscal_document(p_document_id uuid, p_reason text)
-- Contrato ESTÁVEL: -> jsonb { "ok": bool, "error": text|null,
--   "minutesElapsed": int|null, "windowMinutes": int|null }
--   error: 'documento_nao_encontrado' | 'nao_autorizado' | 'documento_nao_autorizado'
--        | 'prazo_expirado' | 'justificativa_curta'
-- -----------------------------------------------------------------------------
create or replace function public.cancel_fiscal_document(
  p_document_id uuid,
  p_reason      text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc      public.fiscal_documents%rowtype;
  v_settings public.fiscal_settings%rowtype;
  v_window   integer;
  v_elapsed  integer;
begin
  select * into v_doc from public.fiscal_documents where id = p_document_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'documento_nao_encontrado',
      'minutesElapsed', null, 'windowMinutes', null);
  end if;

  if coalesce(v_doc.tenant_id = public.current_tenant_id(), false) is false then
    return jsonb_build_object('ok', false, 'error', 'nao_autorizado',
      'minutesElapsed', null, 'windowMinutes', null);
  end if;

  if v_doc.status <> 'authorized' then
    return jsonb_build_object('ok', false, 'error', 'documento_nao_autorizado',
      'minutesElapsed', null, 'windowMinutes', null);
  end if;

  if p_reason is null or char_length(trim(p_reason)) < 15 then
    return jsonb_build_object('ok', false, 'error', 'justificativa_curta',
      'minutesElapsed', null, 'windowMinutes', null);
  end if;

  select * into v_settings from public.fiscal_settings where tenant_id = v_doc.tenant_id;
  v_window := case when v_doc.model = 'nfce'
                   then coalesce(v_settings.nfce_cancel_window_minutes, 30)
                   else coalesce(v_settings.nfe_cancel_window_minutes, 1440) end;

  v_elapsed := floor(extract(epoch from (now() - v_doc.authorized_at)) / 60)::integer;

  if v_elapsed > v_window then
    return jsonb_build_object('ok', false, 'error', 'prazo_expirado',
      'minutesElapsed', v_elapsed, 'windowMinutes', v_window);
  end if;

  update public.fiscal_documents
  set status = 'canceled', cancel_reason = trim(p_reason), canceled_at = now()
  where id = p_document_id;

  return jsonb_build_object('ok', true, 'error', null,
    'minutesElapsed', v_elapsed, 'windowMinutes', v_window);
end;
$$;

grant execute on function public.build_fiscal_payload(uuid, public.fiscal_document_model) to authenticated;
grant execute on function public.enqueue_fiscal_document(uuid, public.fiscal_document_model, boolean) to authenticated;
grant execute on function public.cancel_fiscal_document(uuid, text) to authenticated;
-- mark_fiscal_result é chamada pelo worker de emissão (service_role).
revoke execute on function public.mark_fiscal_result(uuid, public.fiscal_document_status, text, text, text, text, jsonb, text, text)
  from public, anon, authenticated;
