import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { toIntegration } from '../src/modules/integrations/routes.js'
import { isTokenValid } from '../src/modules/integrations/channels/types.js'
import { createFakeSupabase, type TableRows } from './fake-supabase.js'
import { bearer, buildTestServer, customerToken, staffToken, STAFF_A, TENANT_A } from './helpers.js'

const INTEGRATION_ID = '11100000-0000-0000-0000-000000000001'

const TABLES: TableRows = {
  users: [{ id: STAFF_A, tenant_id: TENANT_A, is_active: true, roles: { permissions: { '*': true } } }],
  integrations: [
    {
      id: INTEGRATION_ID, tenant_id: TENANT_A, channel: 'ifood', status: 'connected',
      external_store_id: 'merchant-abc', store_name: 'Lancheria no iFood',
      auto_accept: false, is_receiving: true, last_sync_at: null, last_error: null,
    },
  ],
  integration_credentials: [{ integration_id: INTEGRATION_ID }],
  integration_item_map: [
    {
      id: 'aaaa1111-0000-0000-0000-000000000001', integration_id: INTEGRATION_ID,
      product_id: '20000000-0000-0000-0000-000000000001', option_id: null,
      external_item_id: 'IFD-XSALADA', external_name: 'X-Salada',
    },
  ],
}

describe('isTokenValid', () => {
  it('aceita token com folga confortável', () => {
    expect(isTokenValid(new Date(Date.now() + 600_000).toISOString())).toBe(true)
  })
  it('recusa token já vencido', () => {
    expect(isTokenValid(new Date(Date.now() - 1000).toISOString())).toBe(false)
  })
  it('recusa token que vence dentro da margem de segurança', () => {
    // Um token que expira em 5s não sobreviveria à própria chamada.
    expect(isTokenValid(new Date(Date.now() + 5_000).toISOString(), 60)).toBe(false)
  })
  it('recusa valor ausente ou inválido', () => {
    expect(isTokenValid(null)).toBe(false)
    expect(isTokenValid('nao-e-data')).toBe(false)
  })
})

describe('toIntegration', () => {
  it('expõe a existência da credencial sem devolver o segredo', () => {
    const integration = toIntegration(TABLES.integrations![0] as never, true)
    expect(integration.hasCredentials).toBe(true)
    expect(JSON.stringify(integration)).not.toContain('secret')
  })
  it('sinaliza canal sem credencial configurada', () => {
    expect(toIntegration(TABLES.integrations![0] as never, false).hasCredentials).toBe(false)
  })
})

describe('rotas de integração', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = await buildTestServer()
    app.addHook('onRequest', async (request) => {
      const fake = createFakeSupabase(TABLES)
      request.supabase = fake
      Object.defineProperty(app, 'supabaseAdmin', { value: fake, configurable: true })
    })
  })
  afterAll(async () => {
    await app.close()
  })

  it('exige autenticação', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/integrations' })
    expect(res.statusCode).toBe(401)
  })

  it('recusa cliente B2C', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/integrations',
      headers: bearer(await customerToken()),
    })
    expect(res.statusCode).toBe(403)
  })

  it('lista os canais sem expor segredos', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/integrations',
      headers: bearer(await staffToken()),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveLength(1)
    expect(body[0]).toMatchObject({ channel: 'ifood', hasCredentials: true })
    expect(res.payload).not.toContain('client_secret')
  })

  it('rejeita canal desconhecido na conexão', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      headers: bearer(await staffToken()),
      payload: {
        channel: 'rappi',
        externalStoreId: 'x',
        clientId: 'a',
        clientSecret: 'b',
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('exige credenciais para conectar um canal', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      headers: bearer(await staffToken()),
      payload: { channel: 'ifood', externalStoreId: 'merchant-abc' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('lista o mapeamento de itens do canal', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/integrations/${INTEGRATION_ID}/items`,
      headers: bearer(await staffToken()),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()[0]).toMatchObject({
      externalItemId: 'IFD-XSALADA',
      productId: '20000000-0000-0000-0000-000000000001',
    })
  })

  it('valida o identificador do item externo no mapeamento', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/integrations/${INTEGRATION_ID}/items`,
      headers: bearer(await staffToken()),
      payload: { externalItemId: '' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('permite pausar o recebimento do canal', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/integrations/${INTEGRATION_ID}`,
      headers: bearer(await staffToken()),
      payload: { isReceiving: false },
    })
    expect(res.statusCode).toBe(200)
  })
})
