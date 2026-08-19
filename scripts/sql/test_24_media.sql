-- =============================================================================
-- Asserções da biblioteca de mídias: prefixo por estabelecimento, limites de
-- arquivo, vínculo com produto e detecção de mídia órfã.
-- =============================================================================
\set ON_ERROR_STOP on

\set t1 '10000000-0000-0000-0000-000000000001'
\set t2 '10000000-0000-0000-0000-000000000002'

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);

-- ------------------------- caminho e derivação de tenant ---------------------
select test.assert(
  public.media_storage_prefix(:'t1') = 'tenants/10000000-0000-0000-0000-000000000001/',
  'prefixo do bucket é derivado do estabelecimento');

select test.assert(
  public.storage_path_tenant('tenants/10000000-0000-0000-0000-000000000001/logo.png') = :'t1'::uuid,
  'tenant é extraído do caminho do arquivo');

select test.assert(
  public.storage_path_tenant('logo.png') is null,
  'caminho sem prefixo não resolve estabelecimento');

select test.assert(
  public.storage_path_tenant('tenants/../10000000-0000-0000-0000-000000000001/logo.png') is null,
  'travessia de diretório não resolve estabelecimento');

select test.assert(
  public.storage_path_tenant('tenants/nao-e-uuid/logo.png') is null,
  'segmento que não é uuid não resolve estabelecimento');

-- ------------------------------ registro de mídia ----------------------------
select public.register_media(
  :'t1', 'tenants/10000000-0000-0000-0000-000000000001/logo.png',
  'https://cdn/t1/logo.png', 'image/png', 24000, 'logo', 512, 512, 'Logo da lancheria');

select test.assert(
  (select count(*) from public.tenant_media where tenant_id = :'t1') = 1,
  'arquivo enviado vira registro na biblioteca');

-- Enviar a logo já é dizer para que ela serve: a identidade visual aponta
-- para ela sem um segundo passo.
select test.assert(
  (select logo_url from public.tenant_branding where tenant_id = :'t1') = 'https://cdn/t1/logo.png',
  'envio de logo já aplica a imagem na identidade visual');

-- Reenvio do mesmo caminho é substituição, não duplicata.
select public.register_media(
  :'t1', 'tenants/10000000-0000-0000-0000-000000000001/logo.png',
  'https://cdn/t1/logo-v2.png', 'image/png', 26000, 'logo', 512, 512);

select test.assert(
  (select count(*) from public.tenant_media where tenant_id = :'t1') = 1
  and (select public_url from public.tenant_media
       where storage_path = 'tenants/10000000-0000-0000-0000-000000000001/logo.png')
      = 'https://cdn/t1/logo-v2.png',
  'reenviar o mesmo caminho substitui o registro em vez de duplicar');

select test.assert(
  (select alt_text from public.tenant_media
   where storage_path = 'tenants/10000000-0000-0000-0000-000000000001/logo.png')
  = 'Logo da lancheria',
  'reenvio sem texto alternativo preserva o que já havia');

select test.assert_denied(
  $$select public.register_media(
      '10000000-0000-0000-0000-000000000001',
      'tenants/10000000-0000-0000-0000-000000000002/logo.png',
      'https://cdn/roubo.png', 'image/png', 1000, 'logo')$$,
  'registro apontando para a pasta de outro estabelecimento é recusado');

-- ------------------------------ limites do arquivo ---------------------------
select test.assert_denied(
  $$insert into public.tenant_media (tenant_id, storage_path, public_url, mime_type, size_bytes)
    values ('10000000-0000-0000-0000-000000000001',
            'tenants/10000000-0000-0000-0000-000000000001/script.svg',
            'https://cdn/script.svg', 'image/svg+xml', 900)$$,
  'SVG é recusado (seria script executável no domínio do cliente)');

select test.assert_denied(
  $$insert into public.tenant_media (tenant_id, storage_path, public_url, mime_type, size_bytes)
    values ('10000000-0000-0000-0000-000000000001',
            'tenants/10000000-0000-0000-0000-000000000001/enorme.png',
            'https://cdn/enorme.png', 'image/png', 6291456)$$,
  'arquivo acima de 5 MB é recusado');

select test.assert_denied(
  $$insert into public.tenant_media (tenant_id, storage_path, public_url, mime_type, size_bytes)
    values ('10000000-0000-0000-0000-000000000001', 'solto.png',
            'https://cdn/solto.png', 'image/png', 900)$$,
  'caminho fora da pasta do estabelecimento é recusado pela constraint');

-- --------------------------- galeria do produto ------------------------------
select public.register_media(
  :'t1', 'tenants/10000000-0000-0000-0000-000000000001/xsalada-1.jpg',
  'https://cdn/t1/xsalada-1.jpg', 'image/jpeg', 120000, 'product', 1200, 800);

insert into public.product_media (product_id, media_id, position, tenant_id)
select '20000000-0000-0000-0000-000000000001', id, 0, :'t1'
from public.tenant_media where storage_path like '%xsalada-1.jpg';

select test.assert(
  (select tenant_id from public.product_media
   where product_id = '20000000-0000-0000-0000-000000000001') = :'t1'::uuid,
  'tenant do vínculo é derivado do produto, não confiado ao cliente');

-- Mídia de um estabelecimento em produto de outro: o trigger barra antes de
-- qualquer política, porque aqui o vazamento seria de imagem, não de linha.
select public.register_media(
  :'t2', 'tenants/10000000-0000-0000-0000-000000000002/chopp.jpg',
  'https://cdn/t2/chopp.jpg', 'image/jpeg', 90000, 'product');

select test.assert_denied(
  $$insert into public.product_media (product_id, media_id, tenant_id)
    select '20000000-0000-0000-0000-000000000001', id, '10000000-0000-0000-0000-000000000001'
    from public.tenant_media where storage_path like '%chopp.jpg'$$,
  'imagem de outro estabelecimento não pode ser anexada ao produto');

-- ------------------------------- mídia órfã ----------------------------------
select public.register_media(
  :'t1', 'tenants/10000000-0000-0000-0000-000000000001/antiga.jpg',
  'https://cdn/t1/antiga.jpg', 'image/jpeg', 50000, 'other');

select test.assert(
  exists (select 1 from public.unused_media(:'t1') where public_url = 'https://cdn/t1/antiga.jpg'),
  'imagem que ninguém referencia aparece como não utilizada');

select test.assert(
  not exists (select 1 from public.unused_media(:'t1') where public_url = 'https://cdn/t1/xsalada-1.jpg'),
  'imagem vinculada a produto não é listada como não utilizada');

select test.assert(
  not exists (select 1 from public.unused_media(:'t1') where public_url = 'https://cdn/t1/logo-v2.png'),
  'imagem em uso na identidade visual não é listada como não utilizada');

-- Categoria com imagem também segura a mídia.
insert into public.categories (tenant_id, name, image_url)
values (:'t1', 'Lanches com foto', 'https://cdn/t1/antiga.jpg');

select test.assert(
  not exists (select 1 from public.unused_media(:'t1') where public_url = 'https://cdn/t1/antiga.jpg'),
  'imagem usada por categoria deixa de ser não utilizada');

-- --------------------------------- RLS ---------------------------------------
set role anon;
select test.assert(
  (select count(*) from public.tenant_media where tenant_id = '10000000-0000-0000-0000-000000000001') > 0,
  'visitante anônimo enxerga as imagens (o cardápio precisa delas antes do login)');
reset role;

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000002"}}', false);
set role authenticated;

select test.assert_denied(
  $$insert into public.tenant_media (tenant_id, storage_path, public_url, mime_type, size_bytes)
    values ('10000000-0000-0000-0000-000000000001',
            'tenants/10000000-0000-0000-0000-000000000001/invasor.png',
            'https://cdn/invasor.png', 'image/png', 900)$$,
  'estabelecimento não grava mídia na biblioteca de outro');

-- RLS filtra o UPDATE cruzado: vira no-op silencioso, então o que se
-- verifica é que o texto alternativo do outro permaneceu.
update public.tenant_media set alt_text = 'sequestrado'
where tenant_id = '10000000-0000-0000-0000-000000000001';
reset role;

select test.assert(
  (select alt_text from public.tenant_media
   where storage_path = 'tenants/10000000-0000-0000-0000-000000000001/logo.png')
  = 'Logo da lancheria',
  'estabelecimento não altera a mídia de outro');

-- O funcionário do tenant 001 (contexto atual) não enxerga a lista de outro
-- estabelecimento: o guard de tenant devolve conjunto vazio.
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);
select test.assert(
  (select count(*) from public.unused_media('10000000-0000-0000-0000-000000000002')) = 0,
  'funcionário não enxerga mídia não utilizada de outro estabelecimento');

-- E que a lista é de fato por estabelecimento: sob service_role, o tenant 002
-- tem a sua própria mídia não utilizada.
select set_config('request.jwt.claims', '{"role":"service_role"}', false);
select test.assert(
  (select count(*) from public.unused_media('10000000-0000-0000-0000-000000000002')) = 1,
  'a lista de não utilizadas é por estabelecimento');

select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
