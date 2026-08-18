import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { toCredentials } from '../src/modules/payments/routes.js'
import { hmacSha256Hex } from '../src/modules/payments/providers/index.js'
import { createFakeSupabase, type TableRows } from './fake-supabase.js'
import { buildTestServer, TENANT_A } from './helpers.js'

const WEBHOOK_SECRET = 'segredo-do-webhook'

const TABLES: TableRows = {
  payment_settings: [
    {
      tenant_id: TENANT_A,
      default_provider: 'mercadopago',
      mercadopago_access_token: 'APP_USR-x',
      mercadopago_webhook_secret: WEBHOOK_SECRET,
      stripe_secret_key: null,
      stripe_webhook_secret: null,
      asaas_api_key: null,
      asaas_webhook_token: null,
    },
  ],
}

describe('toCredentials', () => {
  it('monta apenas os provedores totalmente configurados', () => {
    const credentials = toCredentials(TABLES.payment_settings![0] as never)
    expect(credentials.mercadopago).toEqual({
      accessToken: 'APP_USR-x',
      webhookSecret: WEBHOOK_SECRET,
    })
    expect(credentials.stripe).toBeUndefined()
    expect(credentials.asaas).toBeUndefined()
  })

  it('ignora provedor com credencial pela metade', () => {
    const credentials = toCredentials({
      default_provider: null,
      mercadopago_access_token: 'so-o-token',
      mercadopago_webhook_secret: null,
      stripe_secret_key: null,
      stripe_webhook_secret: null,
      asaas_api_key: null,
      asaas_webhook_token: null,
    } as never)
    expect(credentials.mercadopago).toBeUndefined()
  })

  it('devolve objeto vazio sem configuração', () => {
    expect(toCredentials(null)).toEqual({})
  })
})

describe('POST /api/v1/webhooks/:provider', () => {
  let app: FastifyInstance
  const applied: unknown[] = []

  beforeAll(async () => {
    app = await buildTestServer()
    const fake = createFakeSupabase(TABLES, {
      apply_payment_status: (params) => {
        applied.push(params)
        return {
          ok: true,
          error: null,
          duplicated: params.p_event_id === 'DUPLICADO',
          paymentId: 'pay-1',
          orderPaymentStatus: 'paid',
        }
      },
    })
    Object.defineProperty(app, 'supabaseAdmin', { value: fake, configurable: true })
    app.addHook('onRequest', async (request) => {
      request.supabase = fake
    })
  })

  afterAll(async () => {
    await app.close()
  })

  function signedMercadoPago(paymentId: string, requestId = 'req-1') {
    const ts = Math.floor(Date.now() / 1000)
    const body = JSON.stringify({ action: 'payment.updated', data: { id: paymentId } })
    const v1 = hmacSha256Hex(WEBHOOK_SECRET, `id:${paymentId};request-id:${requestId};ts:${ts};`)
    return {
      body,
      headers: {
        'content-type': 'application/json',
        'x-signature': `ts=${ts},v1=${v1}`,
        'x-request-id': requestId,
      },
    }
  }

  it('aceita notificação assinada e aplica o status', async () => {
    const { body, headers } = signedMercadoPago('MP-1')
    const res = await app.inject({ method: 'POST', url: '/api/v1/webhooks/mercadopago', headers, payload: body })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ received: true, applied: true })
    expect(applied.at(-1)).toMatchObject({ p_provider: 'mercadopago', p_provider_payment_id: 'MP-1' })
  })

  it('recusa notificação com assinatura inválida', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/mercadopago',
      headers: {
        'content-type': 'application/json',
        'x-signature': 'ts=1,v1=falsa',
        'x-request-id': 'req-1',
      },
      payload: JSON.stringify({ data: { id: 'MP-2' } }),
    })
    expect(res.statusCode).toBe(401)
  })

  it('recusa notificação sem assinatura', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/mercadopago',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ data: { id: 'MP-3' } }),
    })
    expect(res.statusCode).toBe(401)
  })

  it('devolve 404 para provedor desconhecido', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/paypal',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    })
    expect(res.statusCode).toBe(404)
  })

  it('não exige autenticação de usuário (o gateway não tem sessão)', async () => {
    const { body, headers } = signedMercadoPago('MP-4')
    const res = await app.inject({ method: 'POST', url: '/api/v1/webhooks/mercadopago', headers, payload: body })
    expect(res.statusCode).not.toBe(401)
  })

  it('rotas normais continuam recebendo JSON já parseado', async () => {
    // Garante que o parser de corpo cru ficou restrito ao escopo do webhook.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/public/delivery/quote',
      payload: { tenantSlug: 'nao-existe', subtotal: 10 },
    })
    expect([404, 400]).toContain(res.statusCode)
  })
})
