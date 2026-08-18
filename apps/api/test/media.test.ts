import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { toMedia } from '../src/modules/media/routes.js'
import {
  buildStoragePath,
  extensionFor,
  pathBelongsToTenant,
  publicUrlFor,
  slugifyFileName,
  storagePrefix,
} from '../src/modules/media/service.js'
import { createFakeSupabase, type FakeWrites, type TableRows } from './fake-supabase.js'
import { bearer, buildTestServer, customerToken, staffToken, STAFF_A, TENANT_A, TENANT_B } from './helpers.js'

const MEDIA_ID = '33300000-0000-0000-0000-000000000001'
const OTHER_MEDIA_ID = '33300000-0000-0000-0000-000000000002'
const PRODUCT_ID = '20000000-0000-0000-0000-000000000001'

const TABLES: TableRows = {
  users: [
    { id: STAFF_A, tenant_id: TENANT_A, is_active: true, roles: { permissions: { '*': true } } },
  ],
  tenant_media: [
    {
      id: MEDIA_ID,
      tenant_id: TENANT_A,
      storage_path: `tenants/${TENANT_A}/logo/marca-abc.png`,
      public_url: 'https://supa.test/storage/v1/object/public/tenant-media/logo.png',
      kind: 'logo',
      mime_type: 'image/png',
      size_bytes: 24_000,
      width: 512,
      height: 512,
      alt_text: 'Logo da lancheria',
      created_at: '2026-08-18T10:00:00.000Z',
    },
    {
      id: OTHER_MEDIA_ID,
      tenant_id: TENANT_B,
      storage_path: `tenants/${TENANT_B}/logo/outra-xyz.png`,
      public_url: 'https://supa.test/storage/v1/object/public/tenant-media/outra.png',
      kind: 'logo',
      mime_type: 'image/png',
      size_bytes: 10_000,
      width: null,
      height: null,
      alt_text: null,
      created_at: '2026-08-18T09:00:00.000Z',
    },
  ],
}

// ---------------------------------------------------------------- caminho ---
describe('caminho do arquivo', () => {
  it('o prefixo é a pasta do estabelecimento', () => {
    expect(storagePrefix(TENANT_A)).toBe(`tenants/${TENANT_A}/`)
  })

  it('a extensão vem do tipo declarado, não do nome enviado', () => {
    // "foto.png.html" não pode virar um .html servido do domínio do cliente.
    const path = buildStoragePath({
      tenantId: TENANT_A,
      kind: 'product',
      fileName: 'foto.png.html',
      mimeType: 'image/png',
      unique: 'abc',
    })
    expect(path.endsWith('.png')).toBe(true)
  })

  it('mantém uma pista do nome original', () => {
    expect(slugifyFileName('X-Salada Especial.JPG')).toBe('x-salada-especial')
  })

  it('remove acento e caractere de caminho do nome', () => {
    expect(slugifyFileName('../pão de açúcar')).toBe('pao-de-acucar')
  })

  it('nome que vira vazio recebe um rótulo padrão', () => {
    expect(slugifyFileName('...')).toBe('arquivo')
  })

  it('o caminho fica dentro da pasta do estabelecimento e separado por finalidade', () => {
    const path = buildStoragePath({
      tenantId: TENANT_A,
      kind: 'cover',
      fileName: 'capa.jpg',
      mimeType: 'image/jpeg',
      unique: 'u1',
    })
    expect(path).toBe(`tenants/${TENANT_A}/cover/capa-u1.jpg`)
  })

  it('dois envios do mesmo nome não se sobrescrevem', () => {
    const base = { tenantId: TENANT_A, kind: 'product' as const, fileName: 'x.jpg', mimeType: 'image/jpeg' as const }
    expect(buildStoragePath({ ...base, unique: 'a' })).not.toBe(
      buildStoragePath({ ...base, unique: 'b' }),
    )
  })

  it('reconhece caminho do próprio estabelecimento', () => {
    expect(pathBelongsToTenant(`tenants/${TENANT_A}/logo/a.png`, TENANT_A)).toBe(true)
  })

  it('recusa caminho de outro estabelecimento', () => {
    expect(pathBelongsToTenant(`tenants/${TENANT_B}/logo/a.png`, TENANT_A)).toBe(false)
  })

  it('recusa travessia de diretório', () => {
    expect(pathBelongsToTenant(`tenants/${TENANT_A}/../${TENANT_B}/a.png`, TENANT_A)).toBe(false)
  })

  it('cada tipo aceito tem extensão canônica', () => {
    expect(extensionFor('image/jpeg')).toBe('jpg')
    expect(extensionFor('image/webp')).toBe('webp')
    expect(extensionFor('image/avif')).toBe('avif')
  })

  it('a URL pública aponta para o objeto no bucket', () => {
    expect(publicUrlFor('https://proj.supabase.co/', 'tenant-media', 'tenants/t/logo.png')).toBe(
      'https://proj.supabase.co/storage/v1/object/public/tenant-media/tenants/t/logo.png',
    )
  })
})

// -------------------------------------------------------------- contrato ----
describe('toMedia', () => {
  it('normaliza a linha do banco para o contrato da API', () => {
    const media = toMedia(TABLES.tenant_media![0] as Record<string, unknown>)
    expect(media).toMatchObject({
      id: MEDIA_ID,
      kind: 'logo',
      sizeBytes: 24_000,
      altText: 'Logo da lancheria',
    })
  })

  it('dimensões ausentes viram null, não zero', () => {
    // Zero seria interpretado como imagem de largura 0 pela tela.
    const media = toMedia(TABLES.tenant_media![1] as Record<string, unknown>)
    expect(media.width).toBeNull()
    expect(media.height).toBeNull()
  })
})

// ----------------------------------------------------------------- rotas ----
describe('rotas de mídia', () => {
  let app: FastifyInstance
  const writes: FakeWrites = { inserted: [], updated: [], deleted: [], signed: [], removed: [] }

  beforeAll(async () => {
    app = await buildTestServer()
    app.addHook('onRequest', async (request) => {
      const fake = createFakeSupabase(
        TABLES,
        {
          register_media: () => MEDIA_ID,
          unused_media: () => [
            {
              id: MEDIA_ID,
              storage_path: `tenants/${TENANT_A}/other/antiga-1.jpg`,
              public_url: 'https://supa.test/antiga.jpg',
              kind: 'other',
              size_bytes: 50_000,
              created_at: '2026-08-18T10:00:00.000Z',
            },
          ],
        },
        writes,
      )
      request.supabase = fake
      Object.defineProperty(app, 'supabaseAdmin', { value: fake, configurable: true })
    })
  })

  beforeEach(() => {
    writes.inserted.length = 0
    writes.updated.length = 0
    writes.deleted.length = 0
    writes.signed.length = 0
    writes.removed.length = 0
  })

  afterAll(async () => {
    await app.close()
  })

  it('exige autenticação para assinar envio', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/media/upload-url' })
    expect(res.statusCode).toBe(401)
  })

  it('cliente final não envia imagem para o estabelecimento', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/media/upload-url',
      headers: bearer(await customerToken()),
      payload: { fileName: 'a.png', mimeType: 'image/png', sizeBytes: 1000 },
    })
    expect(res.statusCode).toBe(403)
  })

  it('assina o envio dentro da pasta do estabelecimento', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/media/upload-url',
      headers: bearer(await staffToken()),
      payload: { fileName: 'minha logo.png', mimeType: 'image/png', sizeBytes: 24_000, kind: 'logo' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.storagePath.startsWith(`tenants/${TENANT_A}/logo/`)).toBe(true)
    expect(body.token).toBeTruthy()
    expect(writes.signed[0]).toBe(body.storagePath)
  })

  it('recusa tipo de arquivo fora da lista', async () => {
    // SVG seria script executável servido do domínio do cliente.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/media/upload-url',
      headers: bearer(await staffToken()),
      payload: { fileName: 'x.svg', mimeType: 'image/svg+xml', sizeBytes: 900 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('recusa arquivo acima do limite antes de assinar', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/media/upload-url',
      headers: bearer(await staffToken()),
      payload: { fileName: 'grande.png', mimeType: 'image/png', sizeBytes: 6 * 1024 * 1024 },
    })
    expect(res.statusCode).toBe(400)
    expect(writes.signed).toHaveLength(0)
  })

  it('registra a imagem enviada', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/media',
      headers: bearer(await staffToken()),
      payload: {
        storagePath: `tenants/${TENANT_A}/logo/marca-abc.png`,
        mimeType: 'image/png',
        sizeBytes: 24_000,
        kind: 'logo',
        altText: 'Logo da lancheria',
      },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().id).toBe(MEDIA_ID)
  })

  it('recusa registro apontando para a pasta de outro estabelecimento', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/media',
      headers: bearer(await staffToken()),
      payload: {
        storagePath: `tenants/${TENANT_B}/logo/roubo.png`,
        mimeType: 'image/png',
        sizeBytes: 1000,
        kind: 'logo',
      },
    })
    expect(res.statusCode).toBe(403)
  })

  it('lista a biblioteca do estabelecimento', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/media',
      headers: bearer(await staffToken()),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().items.length).toBeGreaterThan(0)
  })

  it('filtra a biblioteca por finalidade', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/media?kind=logo',
      headers: bearer(await staffToken()),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().items.every((item: { kind: string }) => item.kind === 'logo')).toBe(true)
  })

  it('soma o espaço ocupado pelas imagens sem uso', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/media/unused',
      headers: bearer(await staffToken()),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().totalBytes).toBe(50_000)
  })

  it('atualiza o texto alternativo', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/media/${MEDIA_ID}`,
      headers: bearer(await staffToken()),
      payload: { altText: 'Marca da casa' },
    })
    expect(res.statusCode).toBe(200)
    expect(writes.updated[0]?.patch).toEqual({ alt_text: 'Marca da casa' })
  })

  it('edição que não atinge nenhuma linha responde 404, não 200 vazio', async () => {
    // É assim que a imagem de outro estabelecimento chega aqui: a RLS filtra
    // a linha e o UPDATE vira no-op. Devolver 200 sugeriria que a edição
    // funcionou. (O bloqueio em si é asserido em scripts/sql/test_24_media.sql,
    // que roda contra um PostgreSQL de verdade — o cliente falso não aplica RLS.)
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/media/33300000-0000-0000-0000-0000000009ff',
      headers: bearer(await staffToken(TENANT_A)),
      payload: { altText: 'sequestrado' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('remover a imagem apaga o arquivo antes do registro', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/media/${MEDIA_ID}`,
      headers: bearer(await staffToken()),
    })
    expect(res.statusCode).toBe(204)
    expect(writes.removed).toEqual([`tenants/${TENANT_A}/logo/marca-abc.png`])
    expect(writes.deleted).toContain('tenant_media')
  })

  it('remover imagem inexistente não apaga arquivo nenhum', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/media/33300000-0000-0000-0000-0000000009ff',
      headers: bearer(await staffToken()),
    })
    expect(res.statusCode).toBe(404)
    expect(writes.removed).toHaveLength(0)
  })

  it('define a galeria do produto na ordem informada', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/products/${PRODUCT_ID}/media`,
      headers: bearer(await staffToken()),
      payload: { mediaIds: [MEDIA_ID, OTHER_MEDIA_ID] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().count).toBe(2)
    const rows = writes.inserted.find((entry) => entry.table === 'product_media')?.rows
    expect(rows?.map((row) => row.position)).toEqual([0, 1])
  })

  it('galeria vazia limpa as fotos sem inserir nada', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/products/${PRODUCT_ID}/media`,
      headers: bearer(await staffToken()),
      payload: { mediaIds: [] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().count).toBe(0)
    expect(writes.deleted).toContain('product_media')
    expect(writes.inserted).toHaveLength(0)
  })
})
