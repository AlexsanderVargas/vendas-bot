-- =============================================================================
-- Janela dos relatórios no fuso do estabelecimento (migration 20260819000041).
--
-- O instante escolhido é proposital: 2026-03-10 02:00 UTC é 2026-03-09 23:00
-- em São Paulo. É a venda das onze da noite — a que o antigo `created_at::date`
-- jogava para o dia seguinte, e que representa toda a faixa das 21h à
-- meia-noite de um restaurante brasileiro.
-- =============================================================================
\set ON_ERROR_STOP on
\set t1 '10000000-0000-0000-0000-000000000001'
\set t2 '10000000-0000-0000-0000-000000000002'
\set noite '2026-03-10 02:00:00+00'

update public.tenants set timezone = 'America/Sao_Paulo' where id = :'t1';
update public.tenants set timezone = 'Pacific/Auckland'   where id = :'t2';

-- Pedido concluído às 23h de 09/03 no horário de São Paulo.
insert into public.orders (id, tenant_id, customer_id, channel, subtotal, delivery_fee,
                           total, status, created_at)
values ('5f000000-0000-0000-0000-000000000001', :'t1',
        '30000000-0000-0000-0000-000000000001', 'takeaway', 100.00, 0, 100.00,
        'completed', :'noite');

-- O mesmo instante, num estabelecimento do outro lado do mundo.
insert into public.orders (id, tenant_id, channel, subtotal, delivery_fee,
                           total, status, created_at)
values ('5f000000-0000-0000-0000-000000000002', :'t2', 'dine_in', 50.00, 0, 50.00,
        'completed', :'noite');

-- --------------------------------------------------------------------------
-- 0. A divergência existe mesmo — sem ela, o resto do teste não provaria nada.
-- --------------------------------------------------------------------------
select test.assert(
  (select created_at::date from public.orders where id = '5f000000-0000-0000-0000-000000000001')
    <> (select (created_at at time zone 'America/Sao_Paulo')::date
        from public.orders where id = '5f000000-0000-0000-0000-000000000001'),
  'o instante escolhido cai em dias diferentes em UTC e no fuso da loja');

-- --------------------------------------------------------------------------
-- 1. DRE: a venda pertence ao dia 09, que é quando ela aconteceu na loja.
-- --------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);

select test.assert(
  (public.dre_report(:'t1', '2026-03-09', '2026-03-09')->>'revenue')::numeric = 100.00,
  'venda das 23h entra no DRE do dia em que foi feita');

select test.assert(
  (public.dre_report(:'t1', '2026-03-10', '2026-03-10')->>'revenue')::numeric = 0,
  'e não aparece no dia seguinte');

select test.assert(
  (public.dre_report(:'t1', '2026-03-01', '2026-03-31')->>'orderCount')::integer = 1,
  'janela larga continua contando a venda uma única vez');

-- --------------------------------------------------------------------------
-- 2. Produtos e marketplaces usam a mesma janela.
-- --------------------------------------------------------------------------
select test.assert(
  (select coalesce(sum(revenue), 0) from public.marketplace_orders_report(:'t1', '2026-03-09', '2026-03-09')) = 100.00,
  'relatório de canais respeita o fuso da loja');

select test.assert(
  (select coalesce(sum(revenue), 0) from public.marketplace_orders_report(:'t1', '2026-03-10', '2026-03-10')) = 0,
  'e não duplica a venda no dia seguinte');

-- --------------------------------------------------------------------------
-- 3. O fuso é POR ESTABELECIMENTO: o mesmo instante, outro dia.
-- --------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"role":"service_role"}', false);
select set_config('request.jwt.claim.sub', '', false);

select test.assert(
  (public.dre_report(:'t2', '2026-03-10', '2026-03-10')->>'revenue')::numeric = 50.00,
  'em Auckland o mesmo instante é dia 10, e o DRE de lá reflete isso');

select test.assert(
  (public.dre_report(:'t2', '2026-03-09', '2026-03-09')->>'revenue')::numeric = 0,
  'a loja de Auckland não enxerga a venda no dia 09');

-- --------------------------------------------------------------------------
-- 4. Sem datas informadas, a janela termina no HOJE da loja — não no de UTC.
-- --------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);

select test.assert(
  (select max(day) from public.cash_flow_report(:'t1'))
    = (now() at time zone 'America/Sao_Paulo')::date,
  'fluxo de caixa sem parâmetro vai até hoje no fuso da loja');

select test.assert(
  (select count(*) from public.cash_flow_report(:'t1')) = 31,
  'a janela padrão continua sendo de 31 dias');

-- --------------------------------------------------------------------------
-- 5. Fuso inválido é recusado no cadastro, não no primeiro relatório.
-- --------------------------------------------------------------------------
select test.assert_denied(
  $$ update public.tenants set timezone = 'America/Nao_Existe'
     where id = '10000000-0000-0000-0000-000000000001' $$,
  'fuso desconhecido é recusado na hora de gravar');

select test.assert(
  (select timezone from public.tenants where id = :'t1') = 'America/Sao_Paulo',
  'o fuso válido permanece depois da tentativa recusada');

select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
