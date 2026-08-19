-- =============================================================================
-- CPF/CNPJ do cliente (migration 20260819000036).
-- O documento é opcional, guardado só com dígitos, e editável pelo próprio
-- cliente — nunca pelo cliente de outro estabelecimento.
-- =============================================================================
\set ON_ERROR_STOP on
\set t1 '10000000-0000-0000-0000-000000000001'

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000c1","app_metadata":{}}', false);

-- ------------------------- o documento é opcional ----------------------------
select test.assert(
  (select count(*) from public.customers
   where tenant_id = :'t1' and cpf_cnpj is null) > 0,
  'cliente sem documento continua válido (campo é opcional)');

-- ---------------------------- formato aceito ---------------------------------
set role authenticated;
update public.customers set cpf_cnpj = '52998224725'
  where auth_user_id = '00000000-0000-0000-0000-0000000000c1' and tenant_id = :'t1';
reset role;

select test.assert(
  (select cpf_cnpj from public.customers
   where auth_user_id = '00000000-0000-0000-0000-0000000000c1' and tenant_id = :'t1') = '52998224725',
  'cliente grava o próprio CPF (grant de coluna inclui cpf_cnpj)');

set role authenticated;
update public.customers set cpf_cnpj = '11222333000181'
  where auth_user_id = '00000000-0000-0000-0000-0000000000c1' and tenant_id = :'t1';
reset role;

select test.assert(
  (select cpf_cnpj from public.customers
   where auth_user_id = '00000000-0000-0000-0000-0000000000c1' and tenant_id = :'t1') = '11222333000181',
  'CNPJ de 14 dígitos também é aceito');

-- ---------------------------- formato recusado -------------------------------
select test.assert_denied(
  $$update public.customers set cpf_cnpj = '529.982.247-25'
    where auth_user_id = '00000000-0000-0000-0000-0000000000c1'$$,
  'documento com pontuação é recusado (guardamos só dígitos)');

select test.assert_denied(
  $$update public.customers set cpf_cnpj = '123'
    where auth_user_id = '00000000-0000-0000-0000-0000000000c1'$$,
  'documento com quantidade de dígitos inválida é recusado');

-- --------------------- limpar o documento é permitido ------------------------
set role authenticated;
update public.customers set cpf_cnpj = null
  where auth_user_id = '00000000-0000-0000-0000-0000000000c1' and tenant_id = :'t1';
reset role;

select test.assert(
  (select cpf_cnpj from public.customers
   where auth_user_id = '00000000-0000-0000-0000-0000000000c1' and tenant_id = :'t1') is null,
  'cliente pode remover o próprio documento');

select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
