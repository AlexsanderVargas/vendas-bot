import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { mapCashError } from '../src/modules/cash/routes.js'
import { createFakeSupabase, type TableRows } from './fake-supabase.js'
import { bearer, buildTestServer, customerToken, staffToken, STAFF_A, TENANT_A } from './helpers.js'

const TABLES: TableRows = {
  users: [{ id: STAFF_A, tenant_id: TENANT_A, is_active: true, roles: { permissions: { '*': true } } }],
}

const RPCS = {
  open_cash_session: (params: Record<string, unknown>) =>
    Number(params.p_opening_amount) > 10000
      ? { ok: false, error: 'sessao_ja_aberta', sessionId: null }
      : { ok: true, error: null, sessionId: 'aaaaaaaa-1111-1111-1111-111111111111' },
  cash_session_summary: () => ({
    openingAmount: '200.00',
    sales: '530.00',
    supplies: '50.00',
    withdrawals: '100.00',
    refunds: '0',
    expectedCash: '300.00',
    byMethod: { cash: '150.00', credit_card: '300.00', pix: '80.00' },
    movementCount: 6,
  }),
  close_cash_session: (params: Record<string, unknown>) => ({
    ok: true,
    error: null,
    expectedCash: '300.00',
    countedAmount: String(params.p_counted_amount),
    difference: String(Number(params.p_counted_amount) - 300),
  }),
}

describe('mapCashError', () => {
  it('mapeia caixa já aberto para 409', () => {
    expect(mapCashError('sessao_ja_aberta').status).toBe(409)
  })
  it('mapeia caixa de outro tenant para 403', () => {
    expect(mapCashError('nao_autorizado').status).toBe(403)
  })
  it('mapeia caixa inexistente para 404', () => {
    expect(mapCashError('sessao_nao_encontrada').status).toBe(404)
  })
})

describe('rotas de caixa', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = await buildTestServer()
    app.addHook('onRequest', async (request) => {
      const fake = createFakeSupabase(TABLES, RPCS)
      request.supabase = fake
      Object.defineProperty(app, 'supabaseAdmin', { value: fake, configurable: true })
    })
  })
  afterAll(async () => {
    await app.close()
  })

  it('exige autenticação', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/cash/sessions', payload: { openingAmount: 100 } })
    expect(res.statusCode).toBe(401)
  })

  it('recusa cliente B2C', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cash/sessions',
      headers: bearer(await customerToken()),
      payload: { openingAmount: 100 },
    })
    expect(res.statusCode).toBe(403)
  })

  it('abre o caixa', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cash/sessions',
      headers: bearer(await staffToken()),
      payload: { openingAmount: 200 },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().sessionId).toBe('aaaaaaaa-1111-1111-1111-111111111111')
  })

  it('recusa fundo de troco negativo', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cash/sessions',
      headers: bearer(await staffToken()),
      payload: { openingAmount: -5 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('propaga caixa já aberto como 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cash/sessions',
      headers: bearer(await staffToken()),
      payload: { openingAmount: 99999 },
    })
    expect(res.statusCode).toBe(409)
  })

  it('converte os numéricos do resumo do turno', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/cash/sessions/aaaaaaaa-1111-1111-1111-111111111111/summary',
      headers: bearer(await staffToken()),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.sales).toBe(530)
    expect(body.expectedCash).toBe(300)
    expect(body.byMethod).toEqual({ cash: 150, credit_card: 300, pix: 80 })
  })

  it('calcula sobra no fechamento', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cash/sessions/aaaaaaaa-1111-1111-1111-111111111111/close',
      headers: bearer(await staffToken()),
      payload: { countedAmount: 310 },
    })
    expect(res.json().difference).toBe(10)
  })

  it('calcula falta no fechamento', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cash/sessions/aaaaaaaa-1111-1111-1111-111111111111/close',
      headers: bearer(await staffToken()),
      payload: { countedAmount: 290 },
    })
    expect(res.json().difference).toBe(-10)
  })

  it('rejeita movimentação com valor zero', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cash/sessions/aaaaaaaa-1111-1111-1111-111111111111/movements',
      headers: bearer(await staffToken()),
      payload: { type: 'sale', method: 'cash', amount: 0 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejeita forma de pagamento desconhecida', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cash/sessions/aaaaaaaa-1111-1111-1111-111111111111/movements',
      headers: bearer(await staffToken()),
      payload: { type: 'sale', method: 'bitcoin', amount: 10 },
    })
    expect(res.statusCode).toBe(400)
  })
})
