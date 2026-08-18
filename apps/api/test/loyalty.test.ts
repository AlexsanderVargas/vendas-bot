import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createFakeSupabase, type TableRows } from './fake-supabase.js'
import { bearer, buildTestServer, customerToken, TENANT_A } from './helpers.js'

const TABLES: TableRows = {
  tenants: [{ id: TENANT_A, slug: 'lancheria-t1', is_active: true }],
  order_reviews: [
    { id: 'aaaaaaaa-0000-0000-0000-000000000001', tenant_id: TENANT_A, rating: 5, comment: 'Ótimo!', created_at: '2026-08-18T00:00:00Z' },
    { id: 'aaaaaaaa-0000-0000-0000-000000000002', tenant_id: TENANT_A, rating: 3, comment: null, created_at: '2026-08-17T00:00:00Z' },
  ],
}

const RPCS = {
  tenant_nps: () => ({
    total: 2, average: 4, promoters: 1, neutrals: 0, detractors: 1, nps: 0,
  }),
  submit_order_review: (params: Record<string, unknown>) => {
    if (Number(params.p_rating) === 1) {
      return { ok: false, error: 'ja_avaliado', reviewId: null }
    }
    return { ok: true, error: null, reviewId: 'bbbbbbbb-0000-0000-0000-000000000001' }
  },
}

describe('reputação e fidelidade', () => {
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

  it('expõe o resumo público de reputação sem autenticação', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/reputation?tenantSlug=lancheria-t1',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(2)
    expect(body.nps).toBe(0)
    expect(body.reviews).toHaveLength(2)
  })

  it('devolve 404 para estabelecimento inexistente', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/reputation?tenantSlug=nao-existe',
    })
    expect(res.statusCode).toBe(404)
  })

  it('exige autenticação para o extrato de pontos', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/loyalty?tenantSlug=lancheria-t1' })
    expect(res.statusCode).toBe(401)
  })

  it('devolve saldo zerado quando o cliente não tem cadastro no tenant', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/loyalty?tenantSlug=lancheria-t1',
      headers: bearer(await customerToken()),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ balance: 0, transactions: [] })
  })

  it('registra avaliação válida', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/50000000-0000-0000-0000-000000000001/review',
      headers: bearer(await customerToken()),
      payload: { rating: 5, comment: 'Chegou quentinho' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().reviewId).toBe('bbbbbbbb-0000-0000-0000-000000000001')
  })

  it('mapeia pedido já avaliado para 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/50000000-0000-0000-0000-000000000001/review',
      headers: bearer(await customerToken()),
      payload: { rating: 1 },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().message).toContain('já foi avaliado')
  })

  it('rejeita nota fora da escala de 1 a 5', async () => {
    for (const rating of [0, 6, 10]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/orders/50000000-0000-0000-0000-000000000001/review',
        headers: bearer(await customerToken()),
        payload: { rating },
      })
      expect(res.statusCode).toBe(400)
    }
  })

  it('exige autenticação para avaliar', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/50000000-0000-0000-0000-000000000001/review',
      payload: { rating: 5 },
    })
    expect(res.statusCode).toBe(401)
  })
})
