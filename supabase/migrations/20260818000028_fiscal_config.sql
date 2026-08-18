-- =============================================================================
-- Migration: Configuração tributária e documentos fiscais
-- Fase 6 / PBI (issue #33) — Fiscal e Tributário
--
-- Estrutura preparada para emissão de NFC-e (modelo 65) e NF-e (modelo 55).
-- A emissão em si depende de certificado digital e credenciamento na SEFAZ.
-- =============================================================================

create type public.tax_regime as enum ('simples_nacional', 'lucro_presumido', 'lucro_real', 'mei');

create type public.fiscal_document_model as enum ('nfce', 'nfe');

create type public.fiscal_document_status as enum (
  'draft',        -- montado, ainda não transmitido
  'queued',       -- na fila de emissão
  'transmitting', -- em transmissão para a SEFAZ
  'authorized',   -- autorizado
  'rejected',     -- rejeitado pela SEFAZ
  'canceled',     -- cancelado dentro do prazo
  'contingency',  -- emitido em contingência offline, pendente de transmissão
  'denied'        -- denegado (irregularidade do destinatário)
);

create type public.fiscal_environment as enum ('production', 'homologation');

-- -----------------------------------------------------------------------------
-- fiscal_settings: perfil fiscal do estabelecimento.
-- O CSC (código de segurança do contribuinte) e a senha do certificado são
-- segredos: a tabela tem RLS habilitada e NENHUMA política de leitura para
-- anon/authenticated — mesmo padrão de payment_settings.
-- -----------------------------------------------------------------------------
create table public.fiscal_settings (
  tenant_id           uuid primary key references public.tenants (id) on delete cascade,
  regime              public.tax_regime not null default 'simples_nacional',
  environment         public.fiscal_environment not null default 'homologation',
  /** Inscrição estadual; ISENTO é válido em alguns casos. */
  state_registration  text,
  municipal_registration text,
  /** CNAE principal. */
  cnae                text constraint fiscal_cnae_format check (cnae is null or cnae ~ '^[0-9]{7}$'),
  /** Série e numeração da NFC-e. */
  nfce_series         integer not null default 1 constraint fiscal_nfce_series_positive check (nfce_series > 0),
  nfe_series          integer not null default 1 constraint fiscal_nfe_series_positive check (nfe_series > 0),
  /** Código de Segurança do Contribuinte e seu identificador. */
  csc_id              text,
  csc_token           text,
  certificate_alias   text,
  certificate_password text,
  certificate_expires_at date,
  /** Provedor de emissão (integrador ou emissor próprio). */
  provider            text,
  provider_api_key    text,
  is_enabled          boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create trigger fiscal_settings_set_updated_at
  before update on public.fiscal_settings
  for each row execute function public.set_updated_at();

alter table public.fiscal_settings enable row level security;
-- Sem políticas: segredos fiscais só pelo service_role.

-- -----------------------------------------------------------------------------
-- product_tax_profiles: tributação por produto.
-- Um produto sem perfil herda o padrão do estabelecimento na montagem do
-- documento — evita bloquear a venda por cadastro incompleto.
-- -----------------------------------------------------------------------------
create table public.product_tax_profiles (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  product_id    uuid references public.products (id) on delete cascade,
  /** Nulo = perfil padrão do estabelecimento. */
  is_default    boolean not null default false,
  ncm           text not null constraint tax_ncm_format check (ncm ~ '^[0-9]{8}$'),
  cest          text constraint tax_cest_format check (cest is null or cest ~ '^[0-9]{7}$'),
  cfop          text not null constraint tax_cfop_format check (cfop ~ '^[0-9]{4}$'),
  /** CST (regime normal) ou CSOSN (Simples Nacional). */
  icms_cst      text constraint tax_icms_cst_format check (icms_cst is null or icms_cst ~ '^[0-9]{2,3}$'),
  icms_rate     numeric(5,2) not null default 0 constraint tax_icms_rate_range check (icms_rate between 0 and 100),
  pis_cst       text constraint tax_pis_cst_format check (pis_cst is null or pis_cst ~ '^[0-9]{2}$'),
  pis_rate      numeric(5,4) not null default 0 constraint tax_pis_rate_range check (pis_rate between 0 and 100),
  cofins_cst    text constraint tax_cofins_cst_format check (cofins_cst is null or cofins_cst ~ '^[0-9]{2}$'),
  cofins_rate   numeric(5,4) not null default 0 constraint tax_cofins_rate_range check (cofins_rate between 0 and 100),
  /** Unidade comercial no documento fiscal (UN, KG, LT...). */
  commercial_unit text not null default 'UN',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint tax_profile_product_unique unique (product_id)
);

-- Um único perfil padrão por estabelecimento.
create unique index product_tax_profiles_one_default
  on public.product_tax_profiles (tenant_id) where is_default;

create index product_tax_profiles_tenant_idx on public.product_tax_profiles (tenant_id);

create trigger product_tax_profiles_set_updated_at
  before update on public.product_tax_profiles
  for each row execute function public.set_updated_at();

-- Perfil de produto herda o tenant do produto; perfil padrão não tem produto.
create or replace function public.sync_tax_profile_tenant()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.product_id is not null then
    select p.tenant_id into strict new.tenant_id
    from public.products p where p.id = new.product_id;
    new.is_default := false;
  elsif not new.is_default then
    raise exception 'perfil tributário sem produto precisa ser o padrão do estabelecimento'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger product_tax_profiles_sync_tenant
  before insert or update of product_id, is_default on public.product_tax_profiles
  for each row execute function public.sync_tax_profile_tenant();

-- -----------------------------------------------------------------------------
-- fiscal_documents: um documento por venda fiscalizada.
-- -----------------------------------------------------------------------------
create table public.fiscal_documents (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  order_id        uuid not null references public.orders (id) on delete restrict,
  model           public.fiscal_document_model not null default 'nfce',
  status          public.fiscal_document_status not null default 'draft',
  environment     public.fiscal_environment not null default 'homologation',
  series          integer not null,
  number          bigint,
  /** Chave de acesso de 44 dígitos. */
  access_key      text constraint fiscal_access_key_format
                  check (access_key is null or access_key ~ '^[0-9]{44}$'),
  protocol        text,
  authorized_at   timestamptz,
  canceled_at     timestamptz,
  cancel_reason   text constraint fiscal_cancel_reason_len
                  check (cancel_reason is null or char_length(cancel_reason) between 15 and 255),
  rejection_code  text,
  rejection_reason text,
  /** Totais apurados no momento da emissão. */
  total_amount    numeric(12,2) not null constraint fiscal_total_positive check (total_amount > 0),
  total_taxes     numeric(12,2) not null default 0 constraint fiscal_taxes_non_negative check (total_taxes >= 0),
  /** Payload enviado e retornado, para auditoria e reprocessamento. */
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb not null default '{}'::jsonb,
  xml             text,
  danfe_url       text,
  attempts        integer not null default 0 constraint fiscal_attempts_non_negative check (attempts >= 0),
  next_attempt_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint fiscal_documents_key_unique unique (access_key),
  constraint fiscal_documents_number_unique unique (tenant_id, model, series, number),
  constraint fiscal_authorized_has_key check (
    status <> 'authorized' or (access_key is not null and protocol is not null)),
  constraint fiscal_canceled_has_reason check (
    status <> 'canceled' or cancel_reason is not null)
);

create index fiscal_documents_order_idx on public.fiscal_documents (order_id);
create index fiscal_documents_tenant_status_idx
  on public.fiscal_documents (tenant_id, status, created_at desc);
-- Fila de emissão: pendentes cujo horário de nova tentativa já chegou.
create index fiscal_documents_queue_idx on public.fiscal_documents (next_attempt_at)
  where status in ('queued', 'contingency');

create trigger fiscal_documents_set_updated_at
  before update on public.fiscal_documents
  for each row execute function public.set_updated_at();

create or replace function public.sync_fiscal_document_tenant()
returns trigger language plpgsql set search_path = '' as $$
begin
  select o.tenant_id into strict new.tenant_id
  from public.orders o where o.id = new.order_id;
  return new;
end;
$$;

create trigger fiscal_documents_sync_tenant
  before insert or update of order_id on public.fiscal_documents
  for each row execute function public.sync_fiscal_document_tenant();

-- -----------------------------------------------------------------------------
-- resolve_tax_profile(p_product_id uuid)
-- Contrato ESTÁVEL: (uuid) -> jsonb
--   { "ncm", "cest", "cfop", "icmsCst", "icmsRate", "pisCst", "pisRate",
--     "cofinsCst", "cofinsRate", "commercialUnit", "source" }
--   source: 'product' | 'tenant_default' | 'none'
--   Resolve a tributação do produto, caindo para o padrão do estabelecimento.
-- -----------------------------------------------------------------------------
create or replace function public.resolve_tax_profile(p_product_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_profile public.product_tax_profiles%rowtype;
  v_tenant  uuid;
  v_source  text;
begin
  select tenant_id into v_tenant from public.products where id = p_product_id;
  if v_tenant is null then
    return jsonb_build_object('source', 'none');
  end if;

  select * into v_profile from public.product_tax_profiles where product_id = p_product_id;
  v_source := 'product';

  if not found then
    select * into v_profile from public.product_tax_profiles
    where tenant_id = v_tenant and is_default;
    v_source := 'tenant_default';
  end if;

  if not found then
    return jsonb_build_object('source', 'none');
  end if;

  return jsonb_build_object(
    'ncm', v_profile.ncm, 'cest', v_profile.cest, 'cfop', v_profile.cfop,
    'icmsCst', v_profile.icms_cst, 'icmsRate', v_profile.icms_rate,
    'pisCst', v_profile.pis_cst, 'pisRate', v_profile.pis_rate,
    'cofinsCst', v_profile.cofins_cst, 'cofinsRate', v_profile.cofins_rate,
    'commercialUnit', v_profile.commercial_unit, 'source', v_source);
end;
$$;

grant execute on function public.resolve_tax_profile(uuid) to authenticated;

-- ------------------------------------ RLS ------------------------------------
alter table public.product_tax_profiles enable row level security;
alter table public.fiscal_documents     enable row level security;

create policy tax_profiles_staff_all on public.product_tax_profiles
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

-- O cliente pode ver o documento do próprio pedido (para baixar o DANFE).
create policy fiscal_documents_select on public.fiscal_documents
  for select to authenticated
  using (
    tenant_id = (select public.current_tenant_id())
    or exists (
      select 1 from public.orders o
      join public.customers c on c.id = o.customer_id
      where o.id = order_id and c.auth_user_id = (select auth.uid()))
  );

create policy fiscal_documents_staff_write on public.fiscal_documents
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

-- Permissões fiscais.
-- 'orders.charge' entra junto: foi semeada no papel de caixa lá no PBI 1 mas
-- nunca chegou ao catálogo criado no PBI 22. O trigger de validação recusava
-- qualquer alteração no papel de caixa por causa disso — inconsistência real
-- que só aparece ao tentar reescrever aquele papel.
insert into public.permission_catalog (key, module, label, description, sort_order) values
  ('orders.charge', 'Pedidos', 'Cobrar pedidos', 'Receber pagamento no caixa', 14),
  ('fiscal.read',  'Fiscal', 'Ver documentos fiscais', null, 95),
  ('fiscal.write', 'Fiscal', 'Emitir e cancelar documentos', 'Inclui configuração tributária', 96)
on conflict (key) do nothing;

update public.roles
set permissions = permissions || '{"fiscal.read": true, "fiscal.write": true}'::jsonb
where tenant_id is null and key in ('owner', 'manager');

update public.roles
set permissions = permissions || '{"fiscal.read": true}'::jsonb
where tenant_id is null and key = 'cashier';
