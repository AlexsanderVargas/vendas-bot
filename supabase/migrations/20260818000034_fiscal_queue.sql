-- =============================================================================
-- Migration: Reivindicação da fila de emissão fiscal
-- Fase 9 / PBI (issue #49) — Operação assistida
--
-- A fila de emissão existia desde a Feature 6 (enqueue_fiscal_document grava,
-- mark_fiscal_result aplica o retorno com backoff), mas faltava a peça do
-- meio: alguém que PEGUE os documentos pendentes para transmitir. Sem ela, o
-- documento entrava na fila e ficava lá.
--
-- Contrato NOVO — nenhuma função existente é alterada.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- claim_fiscal_documents(p_limit integer, p_stale_after interval)
-- Contrato ESTÁVEL: (integer, interval) -> setof (
--   id uuid, tenant_id uuid, model public.fiscal_document_model,
--   environment public.fiscal_environment, series integer,
--   request_payload jsonb, attempts integer)
--
--   Reivindica documentos prontos para transmitir e os move para
--   'transmitting', devolvendo o que o worker precisa para chamar o emissor.
--
--   Reivindica dois grupos:
--     1. 'queued'/'contingency' cujo next_attempt_at já venceu (ou é nulo);
--     2. 'transmitting' parados há mais de p_stale_after — o RESGATE.
--
--   O resgate não é luxo: 'transmitting' não tem next_attempt_at e está fora
--   do índice parcial da fila, então um worker que morre entre reivindicar e
--   registrar o retorno deixaria a nota travada para sempre.
--
--   'for update skip locked': duas instâncias do worker nunca pegam o mesmo
--   documento, e a segunda não fica esperando a primeira — ela simplesmente
--   segue para os próximos.
-- -----------------------------------------------------------------------------
create or replace function public.claim_fiscal_documents(
  p_limit       integer default 10,
  p_stale_after interval default '5 minutes'
)
returns table (
  id              uuid,
  tenant_id       uuid,
  model           public.fiscal_document_model,
  environment     public.fiscal_environment,
  series          integer,
  request_payload jsonb,
  attempts        integer
)
language sql
security definer
set search_path = ''
as $$
  with pronto as (
    select d.id
    from public.fiscal_documents d
    join public.fiscal_settings s on s.tenant_id = d.tenant_id
    where s.is_enabled
      and (
        (d.status in ('queued', 'contingency')
         and (d.next_attempt_at is null or d.next_attempt_at <= now()))
        or
        -- Resgate de documento preso em transmissão.
        (d.status = 'transmitting' and d.updated_at < now() - p_stale_after)
      )
    order by d.created_at
    limit greatest(p_limit, 0)
    for update of d skip locked
  )
  update public.fiscal_documents d
  set status = 'transmitting'
  from pronto
  where d.id = pronto.id
  returning d.id, d.tenant_id, d.model, d.environment, d.series,
            d.request_payload, d.attempts;
$$;

-- Só o backend (service_role) reivindica. Um funcionário autenticado não tem
-- por que mexer na fila de transmissão.
revoke execute on function public.claim_fiscal_documents(integer, interval)
  from public, anon, authenticated;

-- O resgate consulta por status + updated_at; sem índice, viraria varredura
-- da tabela a cada ciclo do worker.
create index fiscal_documents_transmitting_idx
  on public.fiscal_documents (updated_at)
  where status = 'transmitting';

-- -----------------------------------------------------------------------------
-- Endereço do integrador fiscal.
-- fiscal_settings já guardava `provider` e `provider_api_key`, mas não para
-- ONDE transmitir — e cada integrador (Focus, PlugNotas, NFe.io) tem a própria
-- URL, além de ambientes distintos para sandbox e produção. Sem esta coluna o
-- endereço teria de ser fixado no código, o que impediria dois
-- estabelecimentos de usarem integradores diferentes.
-- -----------------------------------------------------------------------------
alter table public.fiscal_settings add column provider_base_url text;

comment on column public.fiscal_settings.provider_base_url is
  'Base da API do integrador fiscal, ex.: https://sandbox.focusnfe.com.br';
