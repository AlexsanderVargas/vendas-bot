-- =============================================================================
-- Migration: Pagamento on-line — intenções, eventos de webhook e conciliação
-- Fase 5 / PBI (issue #28) — Financeiro e Caixa
-- =============================================================================

create type public.payment_provider as enum ('mercadopago', 'stripe', 'asaas', 'manual');

-- Estados de uma cobrança. Distinto de orders.payment_status, que é o
-- resultado consolidado do pedido: um pedido pode ter uma tentativa recusada
-- e outra aprovada.
create type public.payment_intent_status as enum (
  'pending', 'processing', 'approved', 'rejected', 'refunded', 'canceled', 'expired'
);

create table public.payments (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants (id) on delete cascade,
  order_id            uuid not null references public.orders (id) on delete cascade,
  provider            public.payment_provider not null,
  /** Identificador da cobrança no provedor. Único por provedor. */
  provider_payment_id text,
  method              public.payment_method not null,
  status              public.payment_intent_status not null default 'pending',
  amount              numeric(12,2) not null constraint payments_amount_positive check (amount > 0),
  /** PIX Copia e Cola. */
  qr_code             text,
  qr_code_base64      text,
  checkout_url        text,
  expires_at          timestamptz,
  /** Resposta bruta do provedor, para auditoria e suporte. */
  raw                 jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint payments_provider_id_unique unique (provider, provider_payment_id)
);

create index payments_order_idx on public.payments (order_id, created_at desc);
create index payments_tenant_status_idx on public.payments (tenant_id, status, created_at desc);

create trigger payments_set_updated_at
  before update on public.payments
  for each row execute function public.set_updated_at();

-- tenant_id derivado do pedido.
create or replace function public.sync_payment_tenant()
returns trigger language plpgsql set search_path = '' as $$
begin
  select o.tenant_id into strict new.tenant_id
  from public.orders o where o.id = new.order_id;
  return new;
end;
$$;

create trigger payments_sync_tenant
  before insert or update of order_id on public.payments
  for each row execute function public.sync_payment_tenant();

-- -----------------------------------------------------------------------------
-- payment_events: cada notificação recebida do provedor.
-- A unicidade de (provider, provider_event_id) é o que torna o webhook
-- idempotente — gateways reenviam a mesma notificação várias vezes.
-- -----------------------------------------------------------------------------
create table public.payment_events (
  id                uuid primary key default gen_random_uuid(),
  payment_id        uuid references public.payments (id) on delete cascade,
  provider          public.payment_provider not null,
  provider_event_id text not null,
  event_type        text not null,
  payload           jsonb not null default '{}'::jsonb,
  processed_at      timestamptz,
  created_at        timestamptz not null default now(),
  constraint payment_events_unique unique (provider, provider_event_id)
);

create index payment_events_payment_idx on public.payment_events (payment_id, created_at desc);

-- -----------------------------------------------------------------------------
-- apply_payment_status(...)
-- Contrato ESTÁVEL: (p_provider public.payment_provider, p_provider_payment_id text,
--   p_status public.payment_intent_status, p_event_id text, p_event_type text,
--   p_payload jsonb) -> jsonb
--   { "ok": bool, "error": text|null, "duplicated": bool, "paymentId": uuid|null,
--     "orderPaymentStatus": text|null }
--
--   Registra o evento e, se for novo, aplica o status na cobrança e reflete
--   no pedido. Chamada apenas pelo backend com service_role (o webhook não
--   tem sessão de usuário).
--   error: 'pagamento_nao_encontrado'
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

-- ------------------------------------ RLS ------------------------------------
alter table public.payments       enable row level security;
alter table public.payment_events enable row level security;

-- Cliente acompanha o próprio pagamento (para ver o QR do PIX e o status).
create policy payments_select on public.payments
  for select to authenticated
  using (
    tenant_id = (select public.current_tenant_id())
    or exists (
      select 1 from public.orders o
      join public.customers c on c.id = o.customer_id
      where o.id = order_id and c.auth_user_id = (select auth.uid()))
  );

-- Criação e atualização passam pelo backend (service_role): o cliente não
-- pode inventar uma cobrança aprovada.
create policy payment_events_select on public.payment_events
  for select to authenticated
  using (
    exists (select 1 from public.payments p
            where p.id = payment_id
              and p.tenant_id = (select public.current_tenant_id()))
  );

-- Realtime: a tela do cliente mostra o PIX confirmando sozinho.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.payments;
  end if;
end;
$$;
