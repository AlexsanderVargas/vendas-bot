-- =============================================================================
-- Migration: Base de integração com marketplaces (iFood, Uber Eats)
-- Fase 7 / PBI (issue #37) — Integração com marketplaces
--
-- Um pedido do iFood precisa entrar no MESMO fluxo do pedido próprio: aparecer
-- no KDS, baixar estoque pela ficha técnica e entrar no DRE. Por isso ele vira
-- uma linha em public.orders, marcada pela origem, em vez de viver numa
-- tabela paralela.
-- =============================================================================

create type public.integration_channel as enum ('ifood', 'ubereats');

create type public.integration_status as enum ('disconnected', 'connected', 'error', 'paused');

-- Origem do pedido. 'own' é o canal próprio (cardápio digital, salão, balcão).
create type public.order_origin as enum ('own', 'ifood', 'ubereats');

alter table public.orders
  add column origin public.order_origin not null default 'own',
  /** Identificador do pedido no marketplace. */
  add column external_order_id text,
  /** Código curto que o entregador/cliente informa (ex.: 4 dígitos do iFood). */
  add column external_display_id text,
  add column integration_id uuid;

-- Um pedido externo não pode ser ingerido duas vezes.
create unique index orders_external_unique
  on public.orders (origin, external_order_id)
  where external_order_id is not null;

create index orders_origin_idx on public.orders (tenant_id, origin, created_at desc);

-- -----------------------------------------------------------------------------
-- integrations: uma conexão de canal por estabelecimento.
-- Credenciais ficam aqui com RLS que nega tudo fora do service_role, mesmo
-- padrão de payment_settings e fiscal_settings.
-- -----------------------------------------------------------------------------
create table public.integrations (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants (id) on delete cascade,
  channel           public.integration_channel not null,
  status            public.integration_status not null default 'disconnected',
  /** Identificador da loja no marketplace (merchantId / storeId). */
  external_store_id text,
  store_name        text,
  /** Aceite automático de pedidos: quando falso, o operador confirma na tela. */
  auto_accept       boolean not null default false,
  /** Pausa o recebimento sem desconectar o canal. */
  is_receiving      boolean not null default true,
  last_sync_at      timestamptz,
  last_error        text,
  settings          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint integrations_tenant_channel_unique unique (tenant_id, channel)
);

create index integrations_channel_idx on public.integrations (channel, status)
  where status = 'connected';

create trigger integrations_set_updated_at
  before update on public.integrations
  for each row execute function public.set_updated_at();

alter table public.orders
  add constraint orders_integration_fk
  foreign key (integration_id) references public.integrations (id) on delete set null;

-- -----------------------------------------------------------------------------
-- integration_credentials: segredos separados da configuração visível.
-- RLS habilitada e NENHUMA política: só o service_role lê.
-- -----------------------------------------------------------------------------
create table public.integration_credentials (
  integration_id  uuid primary key references public.integrations (id) on delete cascade,
  client_id       text,
  client_secret   text,
  /** Token de acesso em cache e sua validade, para não reautenticar a cada chamada. */
  access_token    text,
  token_expires_at timestamptz,
  refresh_token   text,
  /** Segredo de verificação de assinatura do webhook (Uber Eats). */
  webhook_secret  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger integration_credentials_set_updated_at
  before update on public.integration_credentials
  for each row execute function public.set_updated_at();

alter table public.integration_credentials enable row level security;
-- Sem políticas de propósito.

-- -----------------------------------------------------------------------------
-- integration_item_map: liga o produto interno ao item do marketplace.
-- Sem esse mapa, o pedido externo chega com nomes que não casam com o catálogo
-- e a baixa de estoque pela ficha técnica não acontece.
-- -----------------------------------------------------------------------------
create table public.integration_item_map (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  integration_id   uuid not null references public.integrations (id) on delete cascade,
  product_id       uuid references public.products (id) on delete cascade,
  option_id        uuid references public.product_options (id) on delete cascade,
  external_item_id text not null,
  external_name    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint item_map_target check (
    (product_id is not null and option_id is null)
    or (product_id is null and option_id is not null)),
  constraint item_map_external_unique unique (integration_id, external_item_id)
);

create index integration_item_map_product_idx on public.integration_item_map (product_id)
  where product_id is not null;

create trigger integration_item_map_set_updated_at
  before update on public.integration_item_map
  for each row execute function public.set_updated_at();

create or replace function public.sync_item_map_tenant()
returns trigger language plpgsql set search_path = '' as $$
begin
  select i.tenant_id into strict new.tenant_id
  from public.integrations i where i.id = new.integration_id;

  if new.product_id is not null
     and not exists (select 1 from public.products p
                     where p.id = new.product_id and p.tenant_id = new.tenant_id) then
    raise exception 'produto pertence a outro estabelecimento'
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end;
$$;

create trigger integration_item_map_sync_tenant
  before insert or update of integration_id, product_id on public.integration_item_map
  for each row execute function public.sync_item_map_tenant();

-- -----------------------------------------------------------------------------
-- integration_events: tudo que chega do marketplace.
-- A unicidade de (integration_id, external_event_id) torna o processamento
-- idempotente: polling e webhook reentregam o mesmo evento com frequência.
-- -----------------------------------------------------------------------------
create table public.integration_events (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants (id) on delete cascade,
  integration_id    uuid not null references public.integrations (id) on delete cascade,
  external_event_id text not null,
  event_code        text not null,
  external_order_id text,
  order_id          uuid references public.orders (id) on delete set null,
  payload           jsonb not null default '{}'::jsonb,
  processed_at      timestamptz,
  error             text,
  created_at        timestamptz not null default now(),
  constraint integration_events_unique unique (integration_id, external_event_id)
);

create index integration_events_pending_idx
  on public.integration_events (integration_id, created_at)
  where processed_at is null;
create index integration_events_order_idx on public.integration_events (external_order_id)
  where external_order_id is not null;

create or replace function public.sync_integration_event_tenant()
returns trigger language plpgsql set search_path = '' as $$
begin
  select i.tenant_id into strict new.tenant_id
  from public.integrations i where i.id = new.integration_id;
  return new;
end;
$$;

create trigger integration_events_sync_tenant
  before insert or update of integration_id on public.integration_events
  for each row execute function public.sync_integration_event_tenant();

-- ------------------------------------ RLS ------------------------------------
alter table public.integrations         enable row level security;
alter table public.integration_item_map enable row level security;
alter table public.integration_events   enable row level security;

create policy integrations_staff_all on public.integrations
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

create policy item_map_staff_all on public.integration_item_map
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

create policy integration_events_staff_select on public.integration_events
  for select to authenticated
  using (tenant_id = (select public.current_tenant_id()));
-- Escrita apenas pelo worker de integração (service_role).

-- Permissões do módulo.
insert into public.permission_catalog (key, module, label, description, sort_order) values
  ('integrations.read',  'Integrações', 'Ver integrações', 'Canais conectados e pedidos externos', 85),
  ('integrations.write', 'Integrações', 'Gerenciar integrações', 'Conectar canais e mapear cardápio', 86)
on conflict (key) do nothing;

update public.roles
set permissions = permissions || '{"integrations.read": true, "integrations.write": true}'::jsonb
where tenant_id is null and key in ('owner', 'manager');

update public.roles
set permissions = permissions || '{"integrations.read": true}'::jsonb
where tenant_id is null and key in ('cashier', 'kitchen');

-- -----------------------------------------------------------------------------
-- ingest_external_order(p_integration_id uuid, p_payload jsonb)
-- Contrato ESTÁVEL: -> jsonb
--   { "ok": bool, "error": text|null, "orderId": uuid|null, "orderNumber": bigint|null,
--     "duplicated": bool, "unmappedItems": [text], "totalMismatch": numeric|null }
--
--   Converte o pedido normalizado do marketplace em um pedido interno.
--   error: 'integracao_nao_encontrada' | 'canal_pausado' | 'payload_invalido'
--
--   DIFERENÇA DELIBERADA em relação a checkout_order: aqui o PREÇO VEM DO
--   MARKETPLACE, não do catálogo interno. Quem definiu o que o cliente pagou
--   foi o iFood/Uber Eats; recalcular pelo nosso preço produziria um pedido
--   que não bate com o repasse do parceiro.
--
--   Itens sem mapeamento entram no pedido mesmo assim (a venda não pode ser
--   perdida), mas voltam em unmappedItems: sem product_id não há baixa de
--   estoque pela ficha técnica, e o operador precisa saber disso.
-- -----------------------------------------------------------------------------
create or replace function public.ingest_external_order(
  p_integration_id uuid,
  p_payload        jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_integration public.integrations%rowtype;
  v_external_id text := p_payload->>'externalOrderId';
  v_existing    public.orders%rowtype;
  v_order_id    uuid;
  v_number      bigint;
  v_item        jsonb;
  v_product_id  uuid;
  v_unmapped    jsonb := '[]'::jsonb;
  v_subtotal    numeric(12,2) := coalesce((p_payload->>'subtotal')::numeric, 0);
  v_discount    numeric(12,2) := coalesce((p_payload->>'discount')::numeric, 0);
  v_fee         numeric(12,2) := coalesce((p_payload->>'deliveryFee')::numeric, 0);
  v_declared    numeric(12,2) := (p_payload->>'total')::numeric;
  v_computed    numeric(12,2);
  v_mismatch    numeric(12,2) := null;
  v_channel     public.order_channel;
  v_address     jsonb;
  v_options     jsonb;
  v_option      jsonb;
  v_origin      public.order_origin;
begin
  select * into v_integration from public.integrations where id = p_integration_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'integracao_nao_encontrada',
      'orderId', null, 'orderNumber', null, 'duplicated', false,
      'unmappedItems', v_unmapped, 'totalMismatch', null);
  end if;

  if v_external_id is null or jsonb_typeof(p_payload->'items') <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'payload_invalido',
      'orderId', null, 'orderNumber', null, 'duplicated', false,
      'unmappedItems', v_unmapped, 'totalMismatch', null);
  end if;

  v_origin := v_integration.channel::text::public.order_origin;

  -- Idempotência: polling e webhook reentregam o mesmo pedido.
  select * into v_existing from public.orders
  where origin = v_origin and external_order_id = v_external_id;

  if found then
    return jsonb_build_object('ok', true, 'error', null, 'orderId', v_existing.id,
      'orderNumber', v_existing.order_number, 'duplicated', true,
      'unmappedItems', v_unmapped, 'totalMismatch', null);
  end if;

  if not v_integration.is_receiving then
    return jsonb_build_object('ok', false, 'error', 'canal_pausado',
      'orderId', null, 'orderNumber', null, 'duplicated', false,
      'unmappedItems', v_unmapped, 'totalMismatch', null);
  end if;

  v_channel := coalesce((p_payload->>'channel')::public.order_channel, 'delivery');

  -- Pedido de entrega precisa de endereço pela constraint do PBI 1. Quando o
  -- marketplace faz a própria logística e não expõe o endereço, registramos
  -- isso explicitamente em vez de inventar dados.
  v_address := p_payload->'deliveryAddress';
  if v_channel = 'delivery' and (v_address is null or v_address = 'null'::jsonb) then
    v_address := jsonb_build_object(
      'handledBy', v_integration.channel::text,
      'note', 'Entrega realizada pelo marketplace; endereço não exposto pela API');
  end if;

  -- O total declarado pelo parceiro é a fonte da verdade do que o cliente
  -- pagou. Se não fechar com subtotal - desconto + taxa, a diferença é
  -- reportada em vez de silenciosamente absorvida.
  v_computed := round(v_subtotal - v_discount + v_fee, 2);
  if v_declared is not null and v_declared <> v_computed then
    v_mismatch := round(v_declared - v_computed, 2);
  end if;

  insert into public.orders (
    tenant_id, channel, status, payment_status, origin, external_order_id,
    external_display_id, integration_id, delivery_address,
    subtotal, discount, delivery_fee, total, notes)
  values (
    v_integration.tenant_id, v_channel, 'placed',
    coalesce((p_payload->>'paymentStatus')::public.payment_status, 'pending'),
    v_origin, v_external_id, p_payload->>'displayId', p_integration_id, v_address,
    v_subtotal, v_discount, v_fee, v_computed, p_payload->>'notes')
  returning id, order_number into v_order_id, v_number;

  for v_item in select * from jsonb_array_elements(p_payload->'items') loop
    select m.product_id into v_product_id
    from public.integration_item_map m
    where m.integration_id = p_integration_id
      and m.external_item_id = (v_item->>'externalItemId');

    if v_product_id is null then
      v_unmapped := v_unmapped || jsonb_build_array(
        coalesce(v_item->>'name', v_item->>'externalItemId'));
    end if;

    -- Opcionais chegam já precificados pelo marketplace.
    v_options := '[]'::jsonb;
    for v_option in
      select * from jsonb_array_elements(coalesce(v_item->'options', '[]'::jsonb))
    loop
      v_options := v_options || jsonb_build_array(jsonb_build_object(
        'groupId', null, 'groupName', coalesce(v_option->>'groupName', 'Opcionais'),
        'optionId', null, 'optionName', v_option->>'name',
        'priceDelta', coalesce((v_option->>'priceDelta')::numeric, 0)));
    end loop;

    insert into public.order_items (
      order_id, tenant_id, product_id, product_name, unit_price, quantity,
      notes, selected_options)
    values (
      v_order_id, v_integration.tenant_id, v_product_id,
      coalesce(v_item->>'name', 'Item do parceiro'),
      coalesce((v_item->>'unitPrice')::numeric, 0),
      coalesce((v_item->>'quantity')::numeric, 1),
      v_item->>'notes', v_options);
  end loop;

  -- O trigger recalc_order_totals reescreveu subtotal e total a partir dos
  -- itens. Restaura os valores do parceiro: o repasse é calculado sobre eles,
  -- e arredondamento de item não pode alterar o que o cliente pagou.
  update public.orders
  set subtotal = v_subtotal, discount = v_discount,
      delivery_fee = v_fee, total = v_computed
  where id = v_order_id;

  return jsonb_build_object('ok', true, 'error', null, 'orderId', v_order_id,
    'orderNumber', v_number, 'duplicated', false,
    'unmappedItems', v_unmapped, 'totalMismatch', v_mismatch);
end;
$$;

-- Chamada apenas pelo worker de integração (service_role).
revoke execute on function public.ingest_external_order(uuid, jsonb) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- record_integration_event(...)
-- Contrato ESTÁVEL: (p_integration_id uuid, p_event_id text, p_code text,
--   p_external_order_id text, p_payload jsonb) -> jsonb
--   { "ok": bool, "duplicated": bool, "eventId": uuid|null }
--   Registra o evento de forma idempotente. duplicated=true significa que o
--   marketplace reentregou algo já processado.
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
  v_id uuid;
begin
  insert into public.integration_events
    (integration_id, external_event_id, event_code, external_order_id, payload)
  values (p_integration_id, p_event_id, p_code, p_external_order_id, p_payload)
  on conflict (integration_id, external_event_id) do nothing
  returning id into v_id;

  if v_id is null then
    return jsonb_build_object('ok', true, 'duplicated', true, 'eventId', null);
  end if;

  return jsonb_build_object('ok', true, 'duplicated', false, 'eventId', v_id);
end;
$$;

revoke execute on function public.record_integration_event(uuid, text, text, text, jsonb)
  from public, anon, authenticated;
