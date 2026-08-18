-- =============================================================================
-- Migration: Credenciais de gateway por estabelecimento
-- Fase 5 / PBI (issue #28) — Financeiro e Caixa
--
-- Segredos de gateway não podem trafegar para o navegador. A tabela tem RLS
-- habilitada e NENHUMA política: só o service_role (backend) lê e escreve.
-- Em produção, o ideal é um gerenciador de segredos; aqui fica registrado o
-- limite dessa escolha.
-- =============================================================================

create table public.payment_settings (
  tenant_id            uuid primary key references public.tenants (id) on delete cascade,
  /** Provedor usado por padrão no checkout on-line. */
  default_provider     public.payment_provider,
  mercadopago_access_token text,
  mercadopago_webhook_secret text,
  stripe_secret_key    text,
  stripe_webhook_secret text,
  asaas_api_key        text,
  asaas_webhook_token  text,
  /** Aceita pagamento na entrega/retirada. */
  allow_on_delivery    boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create trigger payment_settings_set_updated_at
  before update on public.payment_settings
  for each row execute function public.set_updated_at();

alter table public.payment_settings enable row level security;
-- Sem políticas de propósito: negado para anon e authenticated.

-- -----------------------------------------------------------------------------
-- tenant_payment_options(p_tenant_id uuid)
-- Contrato ESTÁVEL: (uuid) -> jsonb
--   { "defaultProvider": text|null, "allowOnDelivery": bool, "providers": [text] }
--   Diz ao checkout o que está disponível SEM expor segredo algum.
-- -----------------------------------------------------------------------------
create or replace function public.tenant_payment_options(p_tenant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'defaultProvider', s.default_provider::text,
    'allowOnDelivery', coalesce(s.allow_on_delivery, true),
    'providers', coalesce(
      (select jsonb_agg(provider) from (
        select 'mercadopago' as provider where s.mercadopago_access_token is not null
        union all
        select 'stripe' where s.stripe_secret_key is not null
        union all
        select 'asaas' where s.asaas_api_key is not null
      ) as available), '[]'::jsonb))
  from public.payment_settings s
  where s.tenant_id = p_tenant_id;
$$;

grant execute on function public.tenant_payment_options(uuid) to anon, authenticated;
