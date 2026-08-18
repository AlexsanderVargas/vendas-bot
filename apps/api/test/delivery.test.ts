import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { toEwktPoint } from '../src/lib/customer.js'
import { quoteDelivery, toAddress } from '../src/modules/addresses/service.js'
import { createFakeSupabase, type TableRows } from './fake-supabase.js'
import { bearer, buildTestServer, customerToken, TENANT_A } from './helpers.js'

const TABLES: TableRows = {
  tenants: [{ id: TENANT_A, slug: 'lancheria-t1', is_active: true }],
}

/** Reproduz o contrato de saída de public.quote_delivery. */
const RPCS = {
  quote_delivery: (params: Record<string, unknown>) => ({
    eligible: Number(params.p_subtotal) >= 20,
    fee: '7.20',
    mode: 'distance',
    distance_meters: '1100.00',
    eta_minutes: 45,
    min_order: '20.00',
    reason: Number(params.p_subtotal) >= 20 ? null : 'pedido_minimo',
  }),
}

describe('toEwktPoint', () => {
  it('converte coordenadas válidas para EWKT com longitude primeiro', () => {
    expect(toEwktPoint(-30.0346, -51.2177)).toBe('SRID=4326;POINT(-51.2177 -30.0346)')
  })
  it('devolve null quando falta coordenada', () => {
    expect(toEwktPoint(null, -51.2177)).toBeNull()
    expect(toEwktPoint(-30.0346, undefined)).toBeNull()
  })
  it('rejeita coordenadas fora do intervalo geográfico', () => {
    expect(toEwktPoint(120, 0)).toBeNull()
    expect(toEwktPoint(0, 200)).toBeNull()
  })
})

describe('toAddress', () => {
  it('normaliza a linha do banco e extrai as coordenadas', () => {
    const address = toAddress({
      id: 'addr-1',
      label: 'Casa',
      street: 'Rua A',
      number: '100',
      complement: null,
      neighborhood: 'Centro',
      city: 'Porto Alegre',
      state: 'RS',
      zip_code: '90010000',
      reference: null,
      location: { type: 'Point', coordinates: [-51.21, -30.03] },
      is_default: true,
    })
    expect(address.zipCode).toBe('90010000')
    expect(address.latitude).toBe(-30.03)
    expect(address.longitude).toBe(-51.21)
    expect(address.isDefault).toBe(true)
  })

  it('mantém coordenadas nulas quando o endereço não foi geocodificado', () => {
    const address = toAddress({
      id: 'addr-2', label: 'Trabalho', street: 'Rua B', number: '20',
      complement: 'Sala 3', neighborhood: 'Centro', city: 'Porto Alegre',
      state: 'RS', zip_code: null, reference: null, location: null, is_default: false,
    })
    expect(address.latitude).toBeNull()
    expect(address.longitude).toBeNull()
  })
})

describe('quoteDelivery', () => {
  it('converte os numéricos do jsonb para number', async () => {
    const quote = await quoteDelivery(createFakeSupabase(TABLES, RPCS), {
      tenantId: TENANT_A,
      subtotal: 50,
      latitude: -30.03,
      longitude: -51.21,
    })
    expect(quote).toEqual({
      eligible: true,
      fee: 7.2,
      mode: 'distance',
      distanceMeters: 1100,
      etaMinutes: 45,
      minOrder: 20,
      reason: null,
    })
  })

  it('propaga a recusa por pedido mínimo', async () => {
    const quote = await quoteDelivery(createFakeSupabase(TABLES, RPCS), {
      tenantId: TENANT_A,
      subtotal: 10,
    })
    expect(quote.eligible).toBe(false)
    expect(quote.reason).toBe('pedido_minimo')
    expect(quote.minOrder).toBe(20)
  })
})

describe('rotas de entrega e endereços', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = await buildTestServer()
    app.addHook('onRequest', async (request) => {
      request.supabase = createFakeSupabase(TABLES, RPCS)
    })
  })
  afterAll(async () => {
    await app.close()
  })

  it('cota o frete sem autenticação', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/public/delivery/quote',
      payload: { tenantSlug: 'lancheria-t1', subtotal: 50, latitude: -30.03, longitude: -51.21 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().fee).toBe(7.2)
  })

  it('devolve 404 cotando para estabelecimento inexistente', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/public/delivery/quote',
      payload: { tenantSlug: 'nao-existe', subtotal: 50 },
    })
    expect(res.statusCode).toBe(404)
  })

  it('rejeita cotação com subtotal negativo', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/public/delivery/quote',
      payload: { tenantSlug: 'lancheria-t1', subtotal: -5 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejeita coordenada fora do intervalo permitido', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/public/delivery/quote',
      payload: { tenantSlug: 'lancheria-t1', subtotal: 50, latitude: 999, longitude: 0 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('exige autenticação para listar endereços', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/addresses?tenantSlug=lancheria-t1' })
    expect(res.statusCode).toBe(401)
  })

  it('devolve lista vazia quando o cliente ainda não tem cadastro no tenant', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/addresses?tenantSlug=lancheria-t1',
      headers: bearer(await customerToken()),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })

  it('recusa criar endereço sem cadastro no estabelecimento', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/addresses',
      headers: bearer(await customerToken()),
      payload: {
        tenantSlug: 'lancheria-t1', label: 'Casa', street: 'Rua A', number: '100',
        neighborhood: 'Centro', city: 'Porto Alegre', state: 'RS',
      },
    })
    expect(res.statusCode).toBe(403)
  })

  it('valida o formato do CEP', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/addresses',
      headers: bearer(await customerToken()),
      payload: {
        tenantSlug: 'lancheria-t1', label: 'Casa', street: 'Rua A', number: '100',
        neighborhood: 'Centro', city: 'Porto Alegre', state: 'RS', zipCode: '90010-000',
      },
    })
    expect(res.statusCode).toBe(400)
  })
})
