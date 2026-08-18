-- =============================================================================
-- Asserções da identidade visual: validação de cores, fontes, redes e
-- resolução com padrões.
-- =============================================================================
\set ON_ERROR_STOP on

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000001"}}', false);

-- --------------------------- validação de cor -------------------------------
select test.assert(public.is_hex_color('#FFF'), 'aceita hex de 3 dígitos');
select test.assert(public.is_hex_color('#e85d2a'), 'aceita hex de 6 dígitos em minúsculas');
select test.assert(public.is_hex_color('E85D2A') is false, 'recusa hex sem cerquilha');
select test.assert(public.is_hex_color('#GGGGGG') is false, 'recusa caractere fora do hexadecimal');
select test.assert(public.is_hex_color('red') is false, 'recusa nome de cor CSS');
select test.assert(
  public.is_hex_color('#fff; background: url(x)') is false,
  'recusa tentativa de injeção de CSS');

-- ------------------------- antes de personalizar ----------------------------
create temporary table t_padrao as
select public.resolve_branding('lancheria-t1') as r;

select test.assert(
  ((select r from t_padrao)->>'isCustomized')::boolean is false,
  'estabelecimento sem personalização é sinalizado');

select test.assert(
  ((select r from t_padrao)->>'primaryColor') = '#E85D2A'
  and ((select r from t_padrao)->>'fontFamily') = 'system',
  'sem personalização, o cardápio recebe os padrões do produto');

select test.assert(
  ((select r from t_padrao)->>'displayName') = 'Lancheria T1',
  'nome de exibição cai para o nome do estabelecimento');

select test.assert(
  public.resolve_branding('nao-existe') is null,
  'slug inexistente não devolve identidade');

-- ------------------------------ personalizando -------------------------------
insert into public.tenant_branding (
  tenant_id, logo_url, cover_url, primary_color, primary_contrast,
  accent_color, font_family, theme_mode, corner_radius,
  display_name, tagline, social_links, banner_message)
values ('10000000-0000-0000-0000-000000000001',
        'https://cdn/logo.png', 'https://cdn/capa.jpg', '#2A7FE8', '#FFFFFF',
        '#FFC24B', 'poppins', 'light', 20,
        'Lancheria do Zé', 'O melhor X-Salada da cidade',
        '{"instagram":"@lancheriadoze","whatsapp":"+5551999990001"}'::jsonb,
        'Aberto até meia-noite no feriado');

create temporary table t_custom as
select public.resolve_branding('lancheria-t1') as r;

select test.assert(
  ((select r from t_custom)->>'isCustomized')::boolean,
  'estabelecimento com registro próprio é sinalizado como personalizado');

select test.assert(
  ((select r from t_custom)->>'primaryColor') = '#2A7FE8'
  and ((select r from t_custom)->>'displayName') = 'Lancheria do Zé'
  and ((select r from t_custom)->>'fontFamily') = 'poppins',
  'identidade personalizada é devolvida ao cardápio');

select test.assert(
  ((select r from t_custom)->>'socialImageUrl') = 'https://cdn/capa.jpg',
  'imagem de compartilhamento cai para a capa quando não há uma própria');

select test.assert(
  ((select r from t_custom)->'socialLinks'->>'instagram') = '@lancheriadoze',
  'redes sociais são devolvidas ao cardápio');

select test.assert(
  ((select r from t_custom)->>'bannerMessage') = 'Aberto até meia-noite no feriado',
  'aviso do topo é devolvido');

-- --------------------------- restrições ------------------------------------
select test.assert_denied(
  $$update public.tenant_branding set primary_color = 'roxo'
    where tenant_id = '10000000-0000-0000-0000-000000000001'$$,
  'cor fora do formato hexadecimal é rejeitada');

select test.assert_denied(
  $$update public.tenant_branding set font_family = 'comic-sans'
    where tenant_id = '10000000-0000-0000-0000-000000000001'$$,
  'fonte fora da lista conhecida é rejeitada (evita injeção no CSS servido)');

select test.assert_denied(
  $$update public.tenant_branding set corner_radius = 99
    where tenant_id = '10000000-0000-0000-0000-000000000001'$$,
  'raio de borda fora da faixa é rejeitado');

select test.assert_denied(
  $$update public.tenant_branding set social_links = '{"orkut":"eu"}'::jsonb
    where tenant_id = '10000000-0000-0000-0000-000000000001'$$,
  'rede social não suportada é rejeitada');

select test.assert_denied(
  $$update public.tenant_branding set social_links = '{"instagram":123}'::jsonb
    where tenant_id = '10000000-0000-0000-0000-000000000001'$$,
  'valor de rede social precisa ser texto');

select test.assert_denied(
  $$update public.tenant_branding set tagline = repeat('a', 200)
    where tenant_id = '10000000-0000-0000-0000-000000000001'$$,
  'slogan longo demais é rejeitado');

-- ------------------------------------ RLS ------------------------------------
set role anon;
select test.assert(
  (public.resolve_branding('lancheria-t1')->>'primaryColor') = '#2A7FE8',
  'visitante anônimo enxerga a identidade (o cardápio precisa dela antes do login)');
-- Sem política de escrita para anon, o UPDATE é filtrado pela RLS e vira
-- no-op silencioso: o que se verifica é que a cor permaneceu.
update public.tenant_branding set primary_color = '#000000'
where tenant_id = '10000000-0000-0000-0000-000000000001';
reset role;

select test.assert(
  (select primary_color from public.tenant_branding
   where tenant_id = '10000000-0000-0000-0000-000000000001') = '#2A7FE8',
  'anônimo não altera a identidade visual');
set role anon;
reset role;

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","app_metadata":{"tenant_id":"10000000-0000-0000-0000-000000000002"}}', false);
set role authenticated;
update public.tenant_branding set primary_color = '#000000'
where tenant_id = '10000000-0000-0000-0000-000000000001';
reset role;

select test.assert(
  (select primary_color from public.tenant_branding
   where tenant_id = '10000000-0000-0000-0000-000000000001') = '#2A7FE8',
  'estabelecimento não altera a identidade visual de outro');

select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '{}', false);
