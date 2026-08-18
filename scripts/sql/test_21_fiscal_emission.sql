-- =============================================================================
-- Asserções da emissão fiscal: fila, contingência, retentativa e cancelamento.
-- =============================================================================
\set ON_ERROR_STOP on

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);

-- Limpa documentos dos testes anteriores para partir de um estado conhecido.
delete from public.fiscal_documents where tenant_id = '10000000-0000-0000-0000-000000000001';

-- Garante tributação para todos os produtos do tenant (o padrão já existe).
create temporary table t_ped_fiscal as
select id from public.orders
where tenant_id = '10000000-0000-0000-0000-000000000001'
  and status in ('completed', 'delivered')
order by created_at desc limit 1;

-- ------------------------------- payload -------------------------------------
create temporary table t_payload as
select public.build_fiscal_payload((select id from t_ped_fiscal), 'nfce') as p;

select test.assert(
  jsonb_array_length((select p from t_payload)->'items') > 0,
  'payload fiscal inclui os itens do pedido');

select test.assert(
  jsonb_array_length((select p from t_payload)->'missingTaxProfile') = 0,
  'todos os itens resolvem tributação (perfil padrão cobre)');

select test.assert(
  ((select p from t_payload)->'emitter'->>'name') = 'Lancheria T1',
  'payload inclui os dados do emitente');

-- --------------------------------- fila ---------------------------------------
create temporary table t_doc as
select public.enqueue_fiscal_document((select id from t_ped_fiscal), 'nfce', false) as r;

select test.assert(
  ((select r from t_doc)->>'ok')::boolean
  and ((select r from t_doc)->>'status') = 'queued',
  'documento entra na fila de emissão');

select test.assert(
  ((select r from t_doc)->>'number') is null,
  'numeração não é consumida antes da autorização');

select test.assert(
  ((public.enqueue_fiscal_document((select id from t_ped_fiscal), 'nfce'))->>'error') = 'documento_ja_existe',
  'pedido com documento pendente não entra na fila de novo');

-- Pedido não concluído não emite.
create temporary table t_ped_aberto as
select id from public.orders
where tenant_id = '10000000-0000-0000-0000-000000000001'
  and status in ('placed', 'confirmed', 'preparing')
limit 1;

select test.assert(
  ((public.enqueue_fiscal_document((select id from t_ped_aberto), 'nfce'))->>'error') = 'pedido_nao_concluido',
  'pedido em andamento não gera documento fiscal');

-- ---------------------------- retentativa ------------------------------------
create temporary table t_doc_id as
select ((select r from t_doc)->>'documentId')::uuid as id;

create temporary table t_rejeicao as
select public.mark_fiscal_result((select id from t_doc_id), 'rejected', null, null,
  '539', 'Duplicidade de NF-e') as r;

select test.assert(
  ((select r from t_rejeicao)->>'willRetry')::boolean
  and ((select r from t_rejeicao)->>'status') = 'queued',
  'rejeição dentro do limite volta para a fila');

select test.assert(
  (select next_attempt_at > now() from public.fiscal_documents where id = (select id from t_doc_id)),
  'nova tentativa é agendada no futuro (backoff)');

select test.assert(
  (select attempts from public.fiscal_documents where id = (select id from t_doc_id)) = 1,
  'tentativas são contadas');

-- Esgota o limite (5 configurado por padrão).
select public.mark_fiscal_result((select id from t_doc_id), 'rejected', null, null, '539', 'x');
select public.mark_fiscal_result((select id from t_doc_id), 'rejected', null, null, '539', 'x');
select public.mark_fiscal_result((select id from t_doc_id), 'rejected', null, null, '539', 'x');
create temporary table t_ultima as
select public.mark_fiscal_result((select id from t_doc_id), 'rejected', null, null, '539', 'x') as r;

select test.assert(
  ((select r from t_ultima)->>'willRetry')::boolean is false
  and ((select r from t_ultima)->>'status') = 'rejected',
  'esgotado o limite de tentativas, para de reprocessar');

select test.assert(
  (select next_attempt_at is null from public.fiscal_documents where id = (select id from t_doc_id)),
  'documento esgotado sai da fila');

-- ---------------------------- autorização ------------------------------------
delete from public.fiscal_documents where tenant_id = '10000000-0000-0000-0000-000000000001';

create temporary table t_doc2 as
select ((public.enqueue_fiscal_document((select id from t_ped_fiscal), 'nfce'))->>'documentId')::uuid as id;

select test.assert(
  ((public.mark_fiscal_result((select id from t_doc2), 'authorized'))->>'error') = 'retorno_incompleto',
  'autorização sem chave e protocolo é recusada');

create temporary table t_auth as
select public.mark_fiscal_result((select id from t_doc2), 'authorized',
  '43260812345678000199650010000000011000000017', '143260000000001') as r;

select test.assert(
  ((select r from t_auth)->>'status') = 'authorized'
  and ((select r from t_auth)->>'number')::bigint > 0,
  'autorização consome a numeração e grava chave e protocolo');

-- Numeração é sequencial e sem buraco.
create temporary table t_ped_fiscal2 as
select id from public.orders
where tenant_id = '10000000-0000-0000-0000-000000000001'
  and status in ('completed', 'delivered')
  and id <> (select id from t_ped_fiscal)
order by created_at desc limit 1;

create temporary table t_doc3 as
select ((public.enqueue_fiscal_document((select id from t_ped_fiscal2), 'nfce'))->>'documentId')::uuid as id;

select test.assert(
  ((public.mark_fiscal_result((select id from t_doc3), 'authorized',
    '43260812345678000199650010000000021000000028', '143260000000002'))->>'number')::bigint
  = ((select r from t_auth)->>'number')::bigint + 1,
  'numeração fiscal é sequencial sem buraco');

-- --------------------------- contingência ------------------------------------
delete from public.fiscal_documents
where tenant_id = '10000000-0000-0000-0000-000000000001'
  and order_id = (select id from t_ped_fiscal2);

create temporary table t_conting as
select public.enqueue_fiscal_document((select id from t_ped_fiscal2), 'nfce', true) as r;

select test.assert(
  ((select r from t_conting)->>'status') = 'contingency'
  and ((select r from t_conting)->>'number') is not null,
  'em contingência o documento já nasce numerado, para a venda não parar');

-- --------------------------- cancelamento ------------------------------------
select test.assert(
  ((public.cancel_fiscal_document((select id from t_doc2), 'curto'))->>'error') = 'justificativa_curta',
  'justificativa com menos de 15 caracteres é recusada');

create temporary table t_cancel as
select public.cancel_fiscal_document((select id from t_doc2),
  'Cliente desistiu da compra apos a emissao') as r;

select test.assert(
  ((select r from t_cancel)->>'ok')::boolean,
  'cancelamento dentro do prazo é aceito');

select test.assert(
  (select status from public.fiscal_documents where id = (select id from t_doc2)) = 'canceled',
  'documento fica cancelado');

select test.assert(
  ((public.cancel_fiscal_document((select id from t_doc2), 'Tentando cancelar de novo agora'))->>'error')
    = 'documento_nao_autorizado',
  'documento já cancelado não cancela de novo');

-- Prazo expirado.
delete from public.fiscal_documents
where tenant_id = '10000000-0000-0000-0000-000000000001'
  and order_id = (select id from t_ped_fiscal);

insert into public.fiscal_documents (tenant_id, order_id, model, series, number, total_amount,
  status, access_key, protocol, authorized_at)
values ('10000000-0000-0000-0000-000000000001', (select id from t_ped_fiscal), 'nfce', 1, 9999, 10.00,
        'authorized', '43260812345678000199650010000099991000000099', 'proto', now() - interval '2 hours');

create temporary table t_expirado as
select public.cancel_fiscal_document(
  (select id from public.fiscal_documents where number = 9999),
  'Cancelamento fora do prazo legal permitido') as r;

select test.assert(
  ((select r from t_expirado)->>'error') = 'prazo_expirado'
  and ((select r from t_expirado)->>'minutesElapsed')::int > 30,
  'cancelamento fora da janela de 30 minutos da NFC-e é recusado');

-- Autorização entre estabelecimentos.
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000002"}}', false);
select test.assert(
  ((public.cancel_fiscal_document((select id from public.fiscal_documents where number = 9999),
    'Tentativa de outro estabelecimento aqui'))->>'error') = 'nao_autorizado',
  'documento de outro estabelecimento não pode ser cancelado');

select test.assert(
  ((public.enqueue_fiscal_document((select id from t_ped_fiscal), 'nfce'))->>'error') = 'nao_autorizado',
  'pedido de outro estabelecimento não entra na fila');

select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
