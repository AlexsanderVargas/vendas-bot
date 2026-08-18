-- =============================================================================
-- Asserções de estoque: entrada por lote, custo médio ponderado e consumo
-- FEFO/FIFO.
-- =============================================================================
\set ON_ERROR_STOP on

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);

-- Estado conhecido para o insumo "Pão" (não perecível, unidade avulsa).
update public.ingredients set stock_quantity = 0, average_cost = 0
  where id = 'b0000000-0000-0000-0000-000000000002';

-- Entrada 1: 100 un a R$ 1,00
select test.assert(
  ((public.receive_stock('b0000000-0000-0000-0000-000000000002', 100, 1.00))->>'ok')::boolean,
  'entrada de mercadoria cria lote');

select test.assert(
  (select stock_quantity from public.ingredients where id = 'b0000000-0000-0000-0000-000000000002') = 100,
  'saldo consolidado reflete a entrada');

-- Entrada 2: 100 un a R$ 2,00 -> custo médio ponderado = 1,50
select public.receive_stock('b0000000-0000-0000-0000-000000000002', 100, 2.00);
select test.assert(
  (select average_cost from public.ingredients where id = 'b0000000-0000-0000-0000-000000000002') = 1.5000,
  'custo médio ponderado é recalculado na entrada');

select test.assert(
  (select count(*) from public.stock_movements
   where ingredient_id = 'b0000000-0000-0000-0000-000000000002' and type = 'in') = 2,
  'cada entrada gera uma movimentação');

-- Consumo FIFO: 150 un devem sair 100 do primeiro lote e 50 do segundo.
create temporary table t_consumo as
select public.consume_stock('b0000000-0000-0000-0000-000000000002', 150, 'out', 'Produção') as r;

select test.assert(
  ((select r from t_consumo)->>'ok')::boolean
  and ((select r from t_consumo)->>'consumed')::numeric = 150,
  'consumo baixa a quantidade pedida');

select test.assert(
  jsonb_array_length((select r from t_consumo)->'batches') = 2,
  'consumo atravessa mais de um lote quando necessário');

select test.assert(
  (select quantity_remaining from public.stock_batches
   where ingredient_id = 'b0000000-0000-0000-0000-000000000002'
   order by received_at limit 1) = 0,
  'lote mais antigo é esgotado primeiro (FIFO)');

select test.assert(
  (select stock_quantity from public.ingredients where id = 'b0000000-0000-0000-0000-000000000002') = 50,
  'saldo consolidado acompanha o consumo');

-- Estoque insuficiente: consome o que há e sinaliza.
create temporary table t_falta as
select public.consume_stock('b0000000-0000-0000-0000-000000000002', 999, 'out', 'Produção') as r;

select test.assert(
  ((select r from t_falta)->>'ok')::boolean is false
  and ((select r from t_falta)->>'error') = 'estoque_insuficiente'
  and ((select r from t_falta)->>'consumed')::numeric = 50,
  'consumo maior que o saldo baixa o disponível e sinaliza a falta');

select test.assert(
  (select stock_quantity from public.ingredients where id = 'b0000000-0000-0000-0000-000000000002') = 0,
  'saldo zera após consumir todo o disponível');

-- ------------------------------- FEFO (perecível) ----------------------------
update public.ingredients set stock_quantity = 0, average_cost = 0
  where id = 'b0000000-0000-0000-0000-000000000001';

select test.assert(
  ((public.receive_stock('b0000000-0000-0000-0000-000000000001', 1000, 0.05))->>'error') = 'validade_obrigatoria',
  'insumo perecível exige data de validade na entrada');

-- Lote A entra primeiro mas vence depois; lote B entra depois e vence antes.
select public.receive_stock('b0000000-0000-0000-0000-000000000001', 1000, 0.05, current_date + 30, null, 'LOTE-A');
select public.receive_stock('b0000000-0000-0000-0000-000000000001', 1000, 0.06, current_date + 5,  null, 'LOTE-B');

select public.consume_stock('b0000000-0000-0000-0000-000000000001', 800, 'out', 'Produção');

select test.assert(
  (select quantity_remaining from public.stock_batches where batch_code = 'LOTE-B') = 200,
  'FEFO consome primeiro o lote que vence antes, mesmo tendo entrado depois');

select test.assert(
  (select quantity_remaining from public.stock_batches where batch_code = 'LOTE-A') = 1000,
  'lote de validade mais distante permanece intacto');

-- Perda registra o motivo e o tipo correto.
select public.consume_stock('b0000000-0000-0000-0000-000000000001', 200, 'loss', 'Vencido');
select test.assert(
  (select count(*) from public.stock_movements
   where ingredient_id = 'b0000000-0000-0000-0000-000000000001'
     and type = 'loss' and reason = 'Vencido') = 1,
  'perda é registrada com tipo e motivo próprios');

-- Restrições e autorização.
select test.assert(
  ((public.consume_stock('b0000000-0000-0000-0000-000000000001', 0))->>'error') = 'quantidade_invalida',
  'consumo de quantidade zero é recusado');

select test.assert(
  ((public.receive_stock('99999999-9999-9999-9999-999999999999', 10, 1))->>'error') = 'insumo_nao_encontrado',
  'entrada para insumo inexistente é recusada');

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000002"}}', false);
select test.assert(
  ((public.receive_stock('b0000000-0000-0000-0000-000000000002', 10, 1))->>'error') = 'nao_autorizado',
  'entrada em insumo de outro estabelecimento é recusada');

-- UPDATE filtrado pela RLS é no-op silencioso: o que se verifica é que o
-- dado do outro tenant permanece intacto.
set role authenticated;
update public.stock_batches set quantity_remaining = 999 where batch_code = 'LOTE-A';
reset role;
select test.assert(
  (select quantity_remaining from public.stock_batches where batch_code = 'LOTE-A') = 1000,
  'staff de outro tenant não altera lote alheio');

-- Cliente B2C não vê estoque.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","app_metadata":{}}', false);
set role authenticated;
select test.assert((select count(*) from public.stock_batches) = 0, 'cliente não vê lotes de estoque');
select test.assert((select count(*) from public.stock_movements) = 0, 'cliente não vê movimentações');
reset role;

select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
