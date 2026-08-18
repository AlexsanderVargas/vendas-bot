-- =============================================================================
-- Migration: Biblioteca de mídias por estabelecimento
-- Fase 8 / PBI (issue #44) — Identidade visual e personalização
--
-- O estabelecimento envia as próprias imagens (logo, capa, fotos de prato).
-- O arquivo em si vive no Supabase Storage; aqui fica o REGISTRO — quem
-- enviou, que tipo é, tamanho, dimensões e onde está. Isso permite listar a
-- galeria, reaproveitar uma imagem em vários produtos e apagar o arquivo
-- órfão sem varrer o bucket.
--
-- Isolamento: o caminho no bucket começa sempre por 'tenants/<tenant_id>/'.
-- As políticas de storage derivam o tenant do próprio caminho, então um
-- estabelecimento não consegue gravar na pasta de outro nem que forje o
-- corpo da requisição.
-- =============================================================================

create type public.media_kind as enum (
  'logo',        -- marca principal
  'logo_dark',   -- variante para tema escuro
  'favicon',     -- ícone da aba
  'cover',       -- capa do cardápio
  'social',      -- imagem de compartilhamento (Open Graph)
  'product',     -- foto de produto
  'category',    -- imagem de categoria
  'banner',      -- destaque/campanha
  'other'
);

-- -----------------------------------------------------------------------------
-- media_storage_prefix(p_tenant_id uuid)
-- Contrato ESTÁVEL: (uuid) -> text
--   Prefixo obrigatório de qualquer arquivo do estabelecimento. Uma função,
--   e não uma string espalhada, porque banco, API e políticas de storage
--   precisam concordar sobre o formato — divergir aqui vazaria arquivo.
-- -----------------------------------------------------------------------------
create or replace function public.media_storage_prefix(p_tenant_id uuid)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select 'tenants/' || p_tenant_id::text || '/';
$$;

-- -----------------------------------------------------------------------------
-- storage_path_tenant(p_path text)
-- Contrato ESTÁVEL: (text) -> uuid
--   Extrai o tenant de 'tenants/<uuid>/...'. Null quando o caminho não segue
--   o padrão — e caminho fora do padrão é negado pelas políticas.
-- -----------------------------------------------------------------------------
create or replace function public.storage_path_tenant(p_path text)
returns uuid
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_uuid text;
begin
  v_uuid := (regexp_match(p_path, '^tenants/([0-9a-fA-F-]{36})/'))[1];
  if v_uuid is null then return null; end if;
  return v_uuid::uuid;
exception when others then
  return null;
end;
$$;

-- -----------------------------------------------------------------------------
-- tenant_media: o registro de cada arquivo enviado.
-- -----------------------------------------------------------------------------
create table public.tenant_media (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  /** Caminho dentro do bucket, sempre iniciado por media_storage_prefix(). */
  storage_path text not null,
  bucket       text not null default 'tenant-media',
  /** URL pública já resolvida — evita o front remontar a URL do projeto. */
  public_url   text not null,
  kind         public.media_kind not null default 'other',
  mime_type    text not null,
  size_bytes   bigint not null,
  width        integer,
  height       integer,
  /** Texto alternativo: acessibilidade do cardápio público. */
  alt_text     text constraint media_alt_len check (alt_text is null or char_length(alt_text) <= 160),
  /** Hash do conteúdo: permite detectar reenvio do mesmo arquivo. */
  checksum     text,
  uploaded_by  uuid references public.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint media_path_unique unique (bucket, storage_path),
  -- O caminho tem de pertencer ao tenant da linha. Sem isso, um registro
  -- poderia apontar para o arquivo de outro estabelecimento.
  constraint media_path_belongs_to_tenant
    check (storage_path like ('tenants/' || tenant_id::text || '/%')),
  -- Só imagem. Um SVG seria script executável servido do domínio do cliente.
  constraint media_mime_allowed
    check (mime_type in ('image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif')),
  constraint media_size_limit
    check (size_bytes > 0 and size_bytes <= 5 * 1024 * 1024),
  constraint media_dimensions_positive
    check ((width is null or width > 0) and (height is null or height > 0))
);

create index tenant_media_tenant_kind_idx on public.tenant_media (tenant_id, kind, created_at desc);
create index tenant_media_checksum_idx on public.tenant_media (tenant_id, checksum)
  where checksum is not null;

create trigger tenant_media_set_updated_at
  before update on public.tenant_media
  for each row execute function public.set_updated_at();

-- Categorias também ganham imagem: o cardápio com foto por seção converte
-- melhor que a lista de texto.
alter table public.categories add column image_url text;

-- -----------------------------------------------------------------------------
-- product_media: galeria do produto.
-- products.image_url continua sendo a foto principal (contrato de cardápio
-- já publicado, não muda). Esta tabela adiciona as demais, ordenadas.
-- -----------------------------------------------------------------------------
create table public.product_media (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  media_id   uuid not null references public.tenant_media (id) on delete cascade,
  position   smallint not null default 0,
  created_at timestamptz not null default now(),
  constraint product_media_unique unique (product_id, media_id)
);

create index product_media_product_idx on public.product_media (product_id, position);

-- tenant_id derivado do produto, nunca confiado ao cliente (mesmo padrão de
-- sync_order_item_tenant).
create or replace function public.sync_product_media_tenant()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  select p.tenant_id into strict new.tenant_id
  from public.products p where p.id = new.product_id;

  -- A mídia tem de ser do mesmo estabelecimento do produto.
  if not exists (
    select 1 from public.tenant_media m
    where m.id = new.media_id and m.tenant_id = new.tenant_id
  ) then
    raise exception 'mídia não pertence ao estabelecimento do produto'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger product_media_sync_tenant
  before insert or update of product_id, media_id on public.product_media
  for each row execute function public.sync_product_media_tenant();

-- -----------------------------------------------------------------------------
-- register_media(...)
-- Contrato ESTÁVEL:
--   (p_tenant_id uuid, p_storage_path text, p_public_url text,
--    p_mime_type text, p_size_bytes bigint, p_kind public.media_kind,
--    p_width integer, p_height integer, p_alt_text text,
--    p_checksum text, p_uploaded_by uuid) -> uuid
--
--   Registra o arquivo recém-enviado e, quando o tipo é de identidade
--   (logo/favicon/capa/social), JÁ APONTA a identidade visual para ele —
--   enviar a logo e depois ter de selecioná-la seriam dois passos para uma
--   única intenção do usuário.
--   Reenvio do mesmo caminho atualiza o registro em vez de duplicar.
-- -----------------------------------------------------------------------------
create or replace function public.register_media(
  p_tenant_id    uuid,
  p_storage_path text,
  p_public_url   text,
  p_mime_type    text,
  p_size_bytes   bigint,
  p_kind         public.media_kind default 'other',
  p_width        integer default null,
  p_height       integer default null,
  p_alt_text     text default null,
  p_checksum     text default null,
  p_uploaded_by  uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if public.storage_path_tenant(p_storage_path) is distinct from p_tenant_id then
    raise exception 'caminho fora da pasta do estabelecimento'
      using errcode = 'check_violation';
  end if;

  insert into public.tenant_media (
    tenant_id, storage_path, public_url, kind, mime_type, size_bytes,
    width, height, alt_text, checksum, uploaded_by)
  values (
    p_tenant_id, p_storage_path, p_public_url, p_kind, p_mime_type, p_size_bytes,
    p_width, p_height, p_alt_text, p_checksum, p_uploaded_by)
  on conflict (bucket, storage_path) do update
    set public_url = excluded.public_url,
        kind       = excluded.kind,
        mime_type  = excluded.mime_type,
        size_bytes = excluded.size_bytes,
        width      = excluded.width,
        height     = excluded.height,
        alt_text   = coalesce(excluded.alt_text, public.tenant_media.alt_text),
        checksum   = excluded.checksum,
        updated_at = now()
  returning id into v_id;

  -- Encaixa na identidade visual quando o envio já diz para que serve.
  if p_kind in ('logo', 'logo_dark', 'favicon', 'cover', 'social') then
    insert into public.tenant_branding (tenant_id) values (p_tenant_id)
    on conflict (tenant_id) do nothing;

    update public.tenant_branding set
      logo_url         = case when p_kind = 'logo'      then p_public_url else logo_url end,
      logo_dark_url    = case when p_kind = 'logo_dark' then p_public_url else logo_dark_url end,
      favicon_url      = case when p_kind = 'favicon'   then p_public_url else favicon_url end,
      cover_url        = case when p_kind = 'cover'     then p_public_url else cover_url end,
      social_image_url = case when p_kind = 'social'    then p_public_url else social_image_url end
    where tenant_id = p_tenant_id;
  end if;

  return v_id;
end;
$$;

revoke execute on function public.register_media(uuid, text, text, text, bigint, public.media_kind, integer, integer, text, text, uuid)
  from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- unused_media(p_tenant_id uuid)
-- Contrato ESTÁVEL: (uuid) -> setof (id uuid, storage_path text,
--   public_url text, kind public.media_kind, size_bytes bigint,
--   created_at timestamptz)
--
--   Arquivos que ninguém referencia: nem produto, nem categoria, nem
--   identidade visual. É a lista que a tela oferece para liberar espaço.
-- -----------------------------------------------------------------------------
create or replace function public.unused_media(p_tenant_id uuid)
returns table (
  id           uuid,
  storage_path text,
  public_url   text,
  kind         public.media_kind,
  size_bytes   bigint,
  created_at   timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select m.id, m.storage_path, m.public_url, m.kind, m.size_bytes, m.created_at
  from public.tenant_media m
  where m.tenant_id = p_tenant_id
    and not exists (select 1 from public.product_media pm where pm.media_id = m.id)
    and not exists (select 1 from public.products p
                    where p.tenant_id = m.tenant_id and p.image_url = m.public_url)
    and not exists (select 1 from public.categories c
                    where c.tenant_id = m.tenant_id and c.image_url = m.public_url)
    and not exists (
      select 1 from public.tenant_branding b
      where b.tenant_id = m.tenant_id
        and m.public_url in (b.logo_url, b.logo_dark_url, b.favicon_url,
                             b.cover_url, b.social_image_url))
  order by m.created_at desc;
$$;

grant execute on function public.unused_media(uuid) to authenticated;

-- ------------------------------------ RLS ------------------------------------
alter table public.tenant_media enable row level security;
alter table public.product_media enable row level security;

-- Leitura pública: as imagens aparecem no cardápio antes de qualquer login,
-- e a URL do arquivo já é pública no bucket — esconder o registro não
-- protegeria nada e quebraria a vitrine.
create policy tenant_media_select on public.tenant_media
  for select to anon, authenticated using (true);

create policy tenant_media_staff_write on public.tenant_media
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

create policy product_media_select on public.product_media
  for select to anon, authenticated using (true);

create policy product_media_staff_write on public.product_media
  for all to authenticated
  using (tenant_id = (select public.current_tenant_id()))
  with check (tenant_id = (select public.current_tenant_id()));

insert into public.permission_catalog (key, module, label, description, sort_order) values
  ('media.write', 'Configurações', 'Gerenciar mídias', 'Enviar e remover imagens do estabelecimento', 92)
on conflict (key) do nothing;

update public.roles
set permissions = permissions || '{"media.write": true}'::jsonb
where tenant_id is null and key in ('owner', 'manager');

-- -----------------------------------------------------------------------------
-- Bucket e políticas do Supabase Storage.
-- Guardado porque o schema storage só existe em ambiente Supabase; em
-- PostgreSQL local as asserções cobrem o registro e o prefixo de caminho.
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'schema storage ausente — políticas de bucket ignoradas';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('tenant-media', 'tenant-media', true, 5242880,
          array['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif'])
  on conflict (id) do update
    set public = true,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  -- Leitura pública do bucket: o cardápio é aberto.
  execute $p$
    create policy tenant_media_objects_read on storage.objects
      for select to anon, authenticated
      using (bucket_id = 'tenant-media')
  $p$;

  -- Escrita: só na própria pasta, derivada do caminho — o cliente não
  -- escolhe o tenant, o caminho escolhe por ele.
  execute $p$
    create policy tenant_media_objects_write on storage.objects
      for all to authenticated
      using (
        bucket_id = 'tenant-media'
        and public.storage_path_tenant(name) = (select public.current_tenant_id())
      )
      with check (
        bucket_id = 'tenant-media'
        and public.storage_path_tenant(name) = (select public.current_tenant_id())
      )
  $p$;
exception when duplicate_object then
  raise notice 'políticas de storage já existentes — mantidas';
end;
$$;
