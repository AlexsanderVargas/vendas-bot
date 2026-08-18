-- =============================================================================
-- Migration: Identidade visual por estabelecimento (white-label)
-- Fase 8 / PBI (issue #43) — Identidade visual e personalização
--
-- O cardápio digital é a vitrine do CLIENTE, não do SaaS. Logo, cores e
-- textos precisam estar disponíveis ANTES de qualquer login — por isso a
-- leitura é pública, como a de tenants e products.
-- =============================================================================

create type public.theme_mode as enum ('light', 'dark', 'system');

-- -----------------------------------------------------------------------------
-- is_hex_color(value text)
-- Contrato ESTÁVEL: (text) -> boolean
--   Aceita #RGB e #RRGGBB. Cor inválida chegaria como CSS quebrado na
--   vitrine do cliente, então é barrada no banco.
-- -----------------------------------------------------------------------------
create or replace function public.is_hex_color(p_value text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select p_value ~ '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$';
$$;

-- -----------------------------------------------------------------------------
-- tenant_branding: a identidade visual de cada estabelecimento.
-- -----------------------------------------------------------------------------
create table public.tenant_branding (
  tenant_id        uuid primary key references public.tenants (id) on delete cascade,

  -- Imagens
  logo_url         text,
  logo_dark_url    text,
  favicon_url      text,
  cover_url        text,
  /** Imagem usada ao compartilhar o link (Open Graph). */
  social_image_url text,

  -- Paleta. Os nomes seguem o papel na interface, não a cor em si: trocar de
  -- laranja para verde não deve exigir renomear coluna.
  primary_color    text not null default '#E85D2A'
                   constraint branding_primary_hex check (public.is_hex_color(primary_color)),
  primary_contrast text not null default '#FFFFFF'
                   constraint branding_primary_contrast_hex check (public.is_hex_color(primary_contrast)),
  accent_color     text
                   constraint branding_accent_hex check (accent_color is null or public.is_hex_color(accent_color)),
  background_color text
                   constraint branding_background_hex check (background_color is null or public.is_hex_color(background_color)),
  surface_color    text
                   constraint branding_surface_hex check (surface_color is null or public.is_hex_color(surface_color)),
  text_color       text
                   constraint branding_text_hex check (text_color is null or public.is_hex_color(text_color)),

  -- Tipografia. Restringido a uma lista conhecida para não permitir injeção
  -- de valor arbitrário no CSS servido ao cliente final.
  font_family      text not null default 'system'
                   constraint branding_font_allowed check (
                     font_family in ('system', 'inter', 'roboto', 'poppins', 'montserrat',
                                     'lato', 'open-sans', 'nunito', 'playfair', 'oswald')),
  theme_mode       public.theme_mode not null default 'system',
  /** Raio das bordas em px: 0 = quadrado, 24 = bem arredondado. */
  corner_radius    smallint not null default 12
                   constraint branding_radius_range check (corner_radius between 0 and 32),

  -- Conteúdo institucional
  display_name     text constraint branding_display_name_len
                   check (display_name is null or char_length(display_name) between 1 and 80),
  tagline          text constraint branding_tagline_len
                   check (tagline is null or char_length(tagline) <= 160),
  about            text constraint branding_about_len
                   check (about is null or char_length(about) <= 2000),
  /** Redes e contato: { "instagram": "...", "whatsapp": "...", "site": "..." } */
  social_links     jsonb not null default '{}'::jsonb,
  /** Aviso no topo do cardápio (feriado, horário especial). */
  banner_message   text constraint branding_banner_len
                   check (banner_message is null or char_length(banner_message) <= 200),

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create trigger tenant_branding_set_updated_at
  before update on public.tenant_branding
  for each row execute function public.set_updated_at();

-- Só chaves conhecidas em social_links: a tela renderiza cada uma com o
-- ícone certo, e chave livre viraria link sem rótulo.
create or replace function public.validate_social_links()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_key text;
begin
  for v_key in select jsonb_object_keys(new.social_links) loop
    if v_key not in ('instagram', 'facebook', 'whatsapp', 'site', 'tiktok', 'youtube', 'ifood') then
      raise exception 'rede social não suportada: %', v_key using errcode = 'check_violation';
    end if;
    if jsonb_typeof(new.social_links -> v_key) <> 'string' then
      raise exception 'valor de % precisa ser texto', v_key using errcode = 'check_violation';
    end if;
  end loop;
  return new;
end;
$$;

create trigger tenant_branding_validate_social
  before insert or update of social_links on public.tenant_branding
  for each row execute function public.validate_social_links();

-- -----------------------------------------------------------------------------
-- resolve_branding(p_slug text)
-- Contrato ESTÁVEL: (text) -> jsonb
--   { "tenantId", "name", "displayName", "tagline", "about", "logoUrl",
--     "logoDarkUrl", "faviconUrl", "coverUrl", "socialImageUrl",
--     "primaryColor", "primaryContrast", "accentColor", "backgroundColor",
--     "surfaceColor", "textColor", "fontFamily", "themeMode", "cornerRadius",
--     "socialLinks", "bannerMessage", "isCustomized" }
--
--   Devolve a identidade do estabelecimento com os padrões preenchidos quando
--   ele ainda não personalizou nada. isCustomized diz se há registro próprio —
--   a tela usa isso para sugerir a personalização.
--   Null quando o slug não existe ou o estabelecimento está inativo.
-- -----------------------------------------------------------------------------
create or replace function public.resolve_branding(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant   public.tenants%rowtype;
  v_branding public.tenant_branding%rowtype;
  v_custom   boolean := true;
begin
  select * into v_tenant from public.tenants
  where slug = p_slug::extensions.citext and is_active;

  if not found then return null; end if;

  select * into v_branding from public.tenant_branding where tenant_id = v_tenant.id;
  if not found then
    v_custom := false;
    -- Padrões do produto, para o cardápio nunca aparecer sem estilo.
    v_branding.primary_color := '#E85D2A';
    v_branding.primary_contrast := '#FFFFFF';
    v_branding.font_family := 'system';
    v_branding.theme_mode := 'system';
    v_branding.corner_radius := 12;
    v_branding.social_links := '{}'::jsonb;
  end if;

  return jsonb_build_object(
    'tenantId', v_tenant.id,
    'name', v_tenant.name,
    'displayName', coalesce(v_branding.display_name, v_tenant.name),
    'tagline', v_branding.tagline,
    'about', v_branding.about,
    'logoUrl', v_branding.logo_url,
    'logoDarkUrl', v_branding.logo_dark_url,
    'faviconUrl', v_branding.favicon_url,
    'coverUrl', v_branding.cover_url,
    'socialImageUrl', coalesce(v_branding.social_image_url, v_branding.cover_url, v_branding.logo_url),
    'primaryColor', v_branding.primary_color,
    'primaryContrast', v_branding.primary_contrast,
    'accentColor', v_branding.accent_color,
    'backgroundColor', v_branding.background_color,
    'surfaceColor', v_branding.surface_color,
    'textColor', v_branding.text_color,
    'fontFamily', v_branding.font_family,
    'themeMode', v_branding.theme_mode::text,
    'cornerRadius', v_branding.corner_radius,
    'socialLinks', v_branding.social_links,
    'bannerMessage', v_branding.banner_message,
    'isCustomized', v_custom);
end;
$$;

grant execute on function public.resolve_branding(text) to anon, authenticated;

-- ------------------------------------ RLS ------------------------------------
alter table public.tenant_branding enable row level security;

-- Leitura pública: o cardápio precisa da identidade antes de qualquer login.
create policy tenant_branding_select on public.tenant_branding
  for select to anon, authenticated using (true);

create policy tenant_branding_staff_write on public.tenant_branding
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

insert into public.permission_catalog (key, module, label, description, sort_order) values
  ('branding.write', 'Configurações', 'Editar identidade visual', 'Logo, cores e textos do cardápio', 91)
on conflict (key) do nothing;

update public.roles
set permissions = permissions || '{"branding.write": true}'::jsonb
where tenant_id is null and key in ('owner', 'manager');
