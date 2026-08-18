-- =============================================================================
-- Asserções da reivindicação da fila fiscal: exclusividade, resgate de
-- documento preso, respeito ao backoff e isolamento entre estabelecimentos.
-- =============================================================================
\set ON_ERROR_STOP on

\set t1 '10000000-0000-0000-0000-000000000001'
\set t2 '10000000-0000-0000-0000-000000000002'

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);

-- Estado conhecido: os testes anteriores deixaram documentos deste tenant.
delete from public.fiscal_documents where tenant_id = :'t1';

-- Um pedido concluído para pendurar os documentos.
create temporary table t_ped as
select id from public.orders
where tenant_id = :'t1' and status in ('completed', 'delivered')
order by created_at desc limit 1;

-- Documentos criados direto na tabela: aqui o alvo é a reivindicação, não a
-- montagem do payload (essa é asserida em test_21).
insert into public.fiscal_documents (id, tenant_id, order_id, model, status, series, total_amount)
values
  ('dd000000-0000-0000-0000-000000000001', :'t1', (select id from t_ped), 'nfce', 'queued', 1, 10.00),
  ('dd000000-0000-0000-0000-000000000002', :'t1', (select id from t_ped), 'nfce', 'queued', 1, 20.00),
  ('dd000000-0000-0000-0000-000000000003', :'t1', (select id from t_ped), 'nfce', 'queued', 1, 30.00);

-- --------------------------- reivindicação básica ----------------------------
create temporary table t_lote1 as
select * from public.claim_fiscal_documents(2);

select test.assert(
  (select count(*) from t_lote1) = 2,
  'a reivindicação respeita o limite pedido');

select test.assert(
  (select count(*) from public.fiscal_documents
   where id in (select id from t_lote1) and status = 'transmitting') = 2,
  'documento reivindicado sai da fila e entra em transmissão');

select test.assert(
  (select request_payload from t_lote1 limit 1) is not null,
  'a reivindicação devolve o payload que o emissor precisa');

-- Exclusividade: o segundo ciclo não pode devolver o que o primeiro pegou.
-- Sem isso, dois workers transmitiriam a mesma nota à SEFAZ.
create temporary table t_lote2 as
select * from public.claim_fiscal_documents(10);

select test.assert(
  not exists (select 1 from t_lote2 where id in (select id from t_lote1)),
  'ciclo seguinte não reivindica o que já está em transmissão');

select test.assert(
  (select count(*) from t_lote2) = 1,
  'o ciclo seguinte pega exatamente o documento que sobrou');

-- ------------------------------ backoff respeitado ---------------------------
insert into public.fiscal_documents (id, tenant_id, order_id, model, status, series, total_amount, next_attempt_at)
values ('dd000000-0000-0000-0000-000000000004', :'t1', (select id from t_ped), 'nfce', 'queued', 1, 40.00,
        now() + interval '10 minutes');

select test.assert(
  not exists (
    select 1 from public.claim_fiscal_documents(10)
    where id = 'dd000000-0000-0000-0000-000000000004'),
  'documento com nova tentativa agendada para o futuro não é reivindicado');

-- ------------------------------ resgate (reaper) -----------------------------
-- Worker que morre entre reivindicar e registrar o retorno deixa o documento
-- em 'transmitting' — sem next_attempt_at e fora do índice da fila. Sem o
-- resgate, a nota ficaria travada para sempre.
insert into public.fiscal_documents (id, tenant_id, order_id, model, status, series, total_amount)
values ('dd000000-0000-0000-0000-000000000005', :'t1', (select id from t_ped), 'nfce', 'transmitting', 1, 50.00);

-- Simula tempo decorrido. O trigger set_updated_at reescreve updated_at em
-- todo UPDATE — o que é correto em produção, mas impede plantar um horário no
-- passado. Desativá-lo aqui é a única forma de exercitar o resgate sem
-- esperar de verdade.
alter table public.fiscal_documents disable trigger fiscal_documents_set_updated_at;
update public.fiscal_documents set updated_at = now() - interval '30 minutes'
where id = 'dd000000-0000-0000-0000-000000000005';
alter table public.fiscal_documents enable trigger fiscal_documents_set_updated_at;

select test.assert(
  not exists (
    select 1 from public.claim_fiscal_documents(10, interval '1 hour')
    where id = 'dd000000-0000-0000-0000-000000000005'),
  'documento em transmissão recente não é resgatado (o worker ainda pode estar vivo)');

select test.assert(
  exists (
    select 1 from public.claim_fiscal_documents(10, interval '5 minutes')
    where id = 'dd000000-0000-0000-0000-000000000005'),
  'documento preso em transmissão além do limite é resgatado');

-- ------------------------- fiscal desligado no tenant ------------------------
update public.fiscal_settings set is_enabled = false where tenant_id = :'t1';

insert into public.fiscal_documents (id, tenant_id, order_id, model, status, series, total_amount)
values ('dd000000-0000-0000-0000-000000000006', :'t1', (select id from t_ped), 'nfce', 'queued', 1, 60.00);

select test.assert(
  not exists (
    select 1 from public.claim_fiscal_documents(10)
    where id = 'dd000000-0000-0000-0000-000000000006'),
  'estabelecimento com emissão desligada não tem documento reivindicado');

update public.fiscal_settings set is_enabled = true where tenant_id = :'t1';

-- ------------------------- endereço do integrador ----------------------------
select test.assert(
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'fiscal_settings'
      and column_name = 'provider_base_url'),
  'a configuração fiscal guarda o endereço do integrador (cada um tem o seu)');

-- ------------------------ mark_fiscal_result após reivindicar ----------------
-- O contrato de mark_fiscal_result não muda: continua aplicando backoff a
-- partir de 'transmitting', como aplicava a partir de 'queued'.
create temporary table t_rejeitado as
select public.mark_fiscal_result(
  'dd000000-0000-0000-0000-000000000001', 'rejected',
  null, null, '539', 'Duplicidade de NF-e') as r;

select test.assert(
  ((select r from t_rejeitado)->>'ok')::boolean,
  'retorno do emissor é aplicado sobre documento reivindicado');

select test.assert(
  ((select r from t_rejeitado)->>'willRetry')::boolean,
  'rejeição dentro do limite agenda nova tentativa');

select test.assert(
  (select next_attempt_at from public.fiscal_documents
   where id = 'dd000000-0000-0000-0000-000000000001') > now(),
  'a nova tentativa fica no futuro (backoff preservado)');

select test.assert(
  (select status from public.fiscal_documents
   where id = 'dd000000-0000-0000-0000-000000000001') = 'queued',
  'documento rejeitado com retentativa volta para a fila');

-- Autorização encerra o ciclo e consome a numeração.
select public.mark_fiscal_result(
  'dd000000-0000-0000-0000-000000000002', 'authorized',
  '11111111111111111111111111111111111111111111', 'PROT-1');

select test.assert(
  (select number from public.fiscal_documents
   where id = 'dd000000-0000-0000-0000-000000000002') is not null,
  'documento autorizado consome a numeração fiscal');

select test.assert(
  (select next_attempt_at from public.fiscal_documents
   where id = 'dd000000-0000-0000-0000-000000000002') is null,
  'documento autorizado sai da fila de vez');

-- ---------------------- isolamento entre estabelecimentos --------------------
-- A função é SECURITY DEFINER e roda com service_role no worker; o que se
-- verifica aqui é que ela não é alcançável por quem está autenticado.
set role authenticated;
select test.assert_denied(
  $$select * from public.claim_fiscal_documents(1)$$,
  'funcionário autenticado não reivindica a fila de transmissão');
reset role;

select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
