-- =============================================================================
-- Marketplace: registrado ≠ processado, e cancelamento do parceiro
-- (migration 20260819000037).
-- =============================================================================
\set ON_ERROR_STOP on
\set t1 '10000000-0000-0000-0000-000000000001'

-- O worker roda como service_role; é esse o contexto destas asserções.
select set_config('request.jwt.claims', '{"role":"service_role"}', false);

create temporary table t_integ as
select id from public.integrations
where tenant_id = :'t1' and channel = 'ifood'
limit 1;

-- -------------------- registrado ≠ processado --------------------------------
create temporary table t_ev1 as
select public.record_integration_event(
  (select id from t_integ), 'EV-REG-1', 'PLC', 'EXT-REG-1', '{}'::jsonb) as r;

select test.assert(
  ((select r from t_ev1)->>'duplicated')::boolean = false
  and ((select r from t_ev1)->>'processed')::boolean = false,
  'evento inédito não é duplicado nem processado');

select test.assert(
  ((select r from t_ev1)->>'eventId') is not null,
  'evento inédito devolve o id do registro');

-- Reentrega ANTES de processar: precisa ser retentável, não descartável.
create temporary table t_ev2 as
select public.record_integration_event(
  (select id from t_integ), 'EV-REG-1', 'PLC', 'EXT-REG-1', '{}'::jsonb) as r;

select test.assert(
  ((select r from t_ev2)->>'duplicated')::boolean = true
  and ((select r from t_ev2)->>'processed')::boolean = false,
  'evento reentregue e ainda não processado volta como pendente (pedido não se perde)');

select test.assert(
  ((select r from t_ev2)->>'eventId') is not null,
  'o caminho duplicado também devolve o id (antes vinha sempre null)');

-- Depois de processado, aí sim é descartável.
update public.integration_events set processed_at = now()
where external_event_id = 'EV-REG-1';

create temporary table t_ev3 as
select public.record_integration_event(
  (select id from t_integ), 'EV-REG-1', 'PLC', 'EXT-REG-1', '{}'::jsonb) as r;

select test.assert(
  ((select r from t_ev3)->>'duplicated')::boolean = true
  and ((select r from t_ev3)->>'processed')::boolean = true,
  'evento já processado volta como processado e pode ser confirmado');

-- ----------------------- cancelamento do parceiro ----------------------------
select test.assert(
  (public.cancel_external_order((select id from t_integ), 'NAO-EXISTE')->>'error') = 'pedido_nao_encontrado',
  'cancelar pedido inexistente devolve erro nomeado, sem lançar');

-- Pedido externo real para cancelar.
create temporary table t_ped as
select id from public.orders
where tenant_id = :'t1' and status in ('placed', 'confirmed', 'preparing')
limit 1;

update public.orders
set origin = 'ifood', external_order_id = 'EXT-CANCEL-1'
where id = (select id from t_ped);

create temporary table t_cancel as
select public.cancel_external_order(
  (select id from t_integ), 'EXT-CANCEL-1', 'CAN') as r;

select test.assert(
  ((select r from t_cancel)->>'ok')::boolean,
  'cancelamento do parceiro cancela o pedido interno');

select test.assert(
  (select status from public.orders where id = (select id from t_ped)) = 'canceled'
  and (select canceled_at from public.orders where id = (select id from t_ped)) is not null,
  'o pedido fica cancelado e com o carimbo de tempo');

select test.assert(
  (select notes from public.orders where id = (select id from t_ped)) like '%Cancelado pelo parceiro%',
  'o motivo do parceiro fica registrado no pedido');

-- Reentrega do mesmo cancelamento não pode virar erro e travar a fila.
select test.assert(
  (public.cancel_external_order((select id from t_integ), 'EXT-CANCEL-1', 'CAN')->>'ok')::boolean
  and (public.cancel_external_order((select id from t_integ), 'EXT-CANCEL-1', 'CAN')->>'error') = 'ja_cancelado',
  'cancelar de novo é idempotente (ok, já cancelado)');

-- ------------------------------ autorização ----------------------------------
-- Cliente autenticado não cancela pedido de estabelecimento nenhum.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000c1","app_metadata":{}}', false);

select test.assert(
  (public.cancel_external_order((select id from t_integ), 'EXT-CANCEL-1', 'CAN')->>'error') = 'nao_autorizado',
  'cliente não cancela pedido de marketplace');

select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
