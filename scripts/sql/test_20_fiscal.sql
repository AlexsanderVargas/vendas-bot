-- =============================================================================
-- Asserções fiscais: configuração tributária, herança de perfil e documentos.
-- =============================================================================
\set ON_ERROR_STOP on

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);

insert into public.fiscal_settings (tenant_id, regime, environment, nfce_series, is_enabled)
values ('10000000-0000-0000-0000-000000000001', 'simples_nacional', 'homologation', 1, true);

-- ------------------------- perfis tributários --------------------------------
insert into public.product_tax_profiles
  (tenant_id, product_id, is_default, ncm, cfop, icms_cst, icms_rate, commercial_unit)
values ('10000000-0000-0000-0000-000000000001', null, true, '21069090', '5102', '102', 0, 'UN');

insert into public.product_tax_profiles
  (tenant_id, product_id, ncm, cfop, icms_cst, icms_rate, commercial_unit)
values ('10000000-0000-0000-0000-000000000002',  -- tenant errado de propósito
        '20000000-0000-0000-0000-000000000001', '16023200', '5405', '500', 18, 'UN');

select test.assert(
  (select tenant_id from public.product_tax_profiles
   where product_id = '20000000-0000-0000-0000-000000000001')
    = '10000000-0000-0000-0000-000000000001',
  'perfil tributário herda o tenant do produto');

select test.assert(
  (public.resolve_tax_profile('20000000-0000-0000-0000-000000000001')->>'source') = 'product'
  and (public.resolve_tax_profile('20000000-0000-0000-0000-000000000001')->>'ncm') = '16023200',
  'produto com perfil próprio usa a própria tributação');

select test.assert(
  (public.resolve_tax_profile('20000000-0000-0000-0000-0000000000b1')->>'source') = 'tenant_default'
  and (public.resolve_tax_profile('20000000-0000-0000-0000-0000000000b1')->>'ncm') = '21069090',
  'produto sem perfil herda o padrão do estabelecimento');

select test.assert(
  (public.resolve_tax_profile('20000000-0000-0000-0000-000000000003')->>'source') = 'none',
  'produto de estabelecimento sem perfil padrão não resolve tributação');

select test.assert_denied(
  $$insert into public.product_tax_profiles (tenant_id, product_id, ncm, cfop)
    values ('10000000-0000-0000-0000-000000000001',
            '20000000-0000-0000-0000-0000000000b1', '123', '5102')$$,
  'NCM fora do formato de 8 dígitos é rejeitado');

select test.assert_denied(
  $$insert into public.product_tax_profiles (tenant_id, product_id, ncm, cfop)
    values ('10000000-0000-0000-0000-000000000001',
            '20000000-0000-0000-0000-0000000000b1', '21069090', '51020')$$,
  'CFOP fora do formato de 4 dígitos é rejeitado');

select test.assert_denied(
  $$insert into public.product_tax_profiles (tenant_id, product_id, ncm, cfop)
    values ('10000000-0000-0000-0000-000000000001',
            '20000000-0000-0000-0000-000000000001', '21069090', '5102')$$,
  'dois perfis para o mesmo produto é rejeitado');

select test.assert_denied(
  $$insert into public.product_tax_profiles (tenant_id, is_default, ncm, cfop)
    values ('10000000-0000-0000-0000-000000000001', true, '21069090', '5102')$$,
  'dois perfis padrão no mesmo estabelecimento é rejeitado');

select test.assert_denied(
  $$insert into public.product_tax_profiles (tenant_id, ncm, cfop)
    values ('10000000-0000-0000-0000-000000000001', '21069090', '5102')$$,
  'perfil sem produto precisa ser o padrão');

select test.assert_denied(
  $$insert into public.product_tax_profiles (tenant_id, product_id, ncm, cfop, icms_rate)
    values ('10000000-0000-0000-0000-000000000001',
            '20000000-0000-0000-0000-0000000000b1', '21069090', '5102', 150)$$,
  'alíquota acima de 100% é rejeitada');

-- --------------------------- documentos fiscais ------------------------------
create temporary table t_pedido_fiscal as
select id from public.orders
where tenant_id = '10000000-0000-0000-0000-000000000001'
  and status in ('completed', 'delivered')
order by created_at desc limit 1;

insert into public.fiscal_documents (tenant_id, order_id, model, series, total_amount)
values ('10000000-0000-0000-0000-000000000002',  -- tenant errado de propósito
        (select id from t_pedido_fiscal), 'nfce', 1, 56.80);

select test.assert(
  (select tenant_id from public.fiscal_documents where order_id = (select id from t_pedido_fiscal))
    = '10000000-0000-0000-0000-000000000001',
  'documento fiscal herda o tenant do pedido');

select test.assert(
  (select status from public.fiscal_documents where order_id = (select id from t_pedido_fiscal)) = 'draft',
  'documento nasce como rascunho');

select test.assert_denied(
  $$update public.fiscal_documents set status = 'authorized'
    where order_id = (select id from t_pedido_fiscal)$$,
  'documento autorizado sem chave e protocolo é rejeitado');

update public.fiscal_documents
set status = 'authorized', number = 1,
    access_key = '43260812345678000199650010000000011000000017',
    protocol = '143260000000001', authorized_at = now()
where order_id = (select id from t_pedido_fiscal);

select test.assert(
  (select status from public.fiscal_documents where order_id = (select id from t_pedido_fiscal)) = 'authorized',
  'documento com chave e protocolo é autorizado');

select test.assert_denied(
  $$insert into public.fiscal_documents (tenant_id, order_id, model, series, number, total_amount,
      status, access_key, protocol)
    values ('10000000-0000-0000-0000-000000000001', (select id from t_pedido_fiscal),
            'nfce', 1, 1, 10.00, 'authorized', '43260812345678000199650010000000021000000028', 'x')$$,
  'numeração repetida na mesma série é rejeitada');

select test.assert_denied(
  $$update public.fiscal_documents set status = 'canceled'
    where order_id = (select id from t_pedido_fiscal)$$,
  'cancelamento sem justificativa é rejeitado');

select test.assert_denied(
  $$update public.fiscal_documents set status = 'canceled', cancel_reason = 'errado'
    where order_id = (select id from t_pedido_fiscal)$$,
  'justificativa de cancelamento com menos de 15 caracteres é rejeitada');

update public.fiscal_documents
set status = 'canceled', cancel_reason = 'Pedido cancelado pelo cliente antes da entrega',
    canceled_at = now()
where order_id = (select id from t_pedido_fiscal);

select test.assert(
  (select status from public.fiscal_documents where order_id = (select id from t_pedido_fiscal)) = 'canceled',
  'cancelamento com justificativa válida é aceito');

select test.assert_denied(
  $$insert into public.fiscal_documents (tenant_id, order_id, model, series, total_amount, access_key)
    values ('10000000-0000-0000-0000-000000000001', (select id from t_pedido_fiscal),
            'nfce', 2, 10.00, '123')$$,
  'chave de acesso fora dos 44 dígitos é rejeitada');

-- ------------------------------------ RLS ------------------------------------
set role authenticated;
select test.assert(
  (select count(*) from public.fiscal_settings) = 0,
  'nem o funcionário lê os segredos fiscais (só service_role)');
reset role;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","app_metadata":{}}', false);
set role authenticated;
select test.assert(
  (select count(*) from public.product_tax_profiles) = 0,
  'cliente não vê a tributação dos produtos');
reset role;

select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
set role anon;
select test.assert((select count(*) from public.fiscal_documents) = 0, 'anônimo não vê documentos fiscais');
reset role;

-- Catálogo de permissões ficou consistente com os papéis semeados.
select test.assert(
  (select count(*) from public.permission_catalog where key = 'orders.charge') = 1,
  'orders.charge foi incorporada ao catálogo de permissões');
