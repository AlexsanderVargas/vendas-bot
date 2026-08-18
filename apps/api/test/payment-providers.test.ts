import { describe, expect, it, vi } from 'vitest'
import {
  createAsaasProvider,
  createMercadoPagoProvider,
  createStripeProvider,
  hmacSha256Hex,
  isFreshTimestamp,
  mapAsaasStatus,
  mapMercadoPagoStatus,
  mapStripeStatus,
  parseSignatureHeader,
  PaymentProviderError,
  safeEqual,
  toAsaasDueDate,
  toStripeAmount,
} from '../src/modules/payments/providers/index.js'

/**
 * Estes testes exercitam o formato das requisições, o mapeamento de status e
 * a verificação de assinatura com transporte mockado. NÃO substituem
 * homologação em sandbox: nenhuma credencial real foi usada.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const INPUT = {
  amount: 25.9,
  method: 'pix' as const,
  description: 'Pedido nº 7',
  orderId: '50000000-0000-0000-0000-000000000001',
  orderNumber: 7,
  payer: { email: 'cliente@exemplo.com', name: 'Cliente A', document: '12345678909' },
  idempotencyKey: 'idem-1',
}

describe('helpers de assinatura', () => {
  it('extrai campos do cabeçalho de assinatura', () => {
    expect(parseSignatureHeader('ts=123,v1=abc', 'ts')).toBe('123')
    expect(parseSignatureHeader('t=456,v1=def', 'v1')).toBe('def')
    expect(parseSignatureHeader('ts=123', 'v1')).toBeNull()
  })
  it('compara em tempo constante e rejeita tamanhos diferentes', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
  })
  it('rejeita timestamp fora da janela de tolerância', () => {
    const agora = 1_700_000_000_000
    expect(isFreshTimestamp(agora / 1000, 300, agora)).toBe(true)
    expect(isFreshTimestamp(agora / 1000 - 600, 300, agora)).toBe(false)
  })
})

describe('Mercado Pago', () => {
  it('mapeia os status do provedor', () => {
    expect(mapMercadoPagoStatus('approved')).toBe('approved')
    expect(mapMercadoPagoStatus('in_process')).toBe('processing')
    expect(mapMercadoPagoStatus('cancelled')).toBe('canceled')
    expect(mapMercadoPagoStatus('charged_back')).toBe('refunded')
    expect(mapMercadoPagoStatus('status_novo')).toBe('pending')
  })

  it('envia a cobrança PIX no formato documentado e extrai o copia-e-cola', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({
        id: 123456,
        status: 'pending',
        point_of_interaction: {
          transaction_data: {
            qr_code: '00020126580014br.gov.bcb.pix',
            qr_code_base64: 'aGVsbG8=',
            ticket_url: 'https://mp/ticket',
          },
        },
        date_of_expiration: '2026-08-19T00:00:00.000-03:00',
      }),
    )

    const provider = createMercadoPagoProvider({
      accessToken: 'TEST-token',
      webhookSecret: 'segredo',
      fetchImpl,
    })
    const result = await provider.createPayment(INPUT)

    expect(result.providerPaymentId).toBe('123456')
    expect(result.qrCode).toBe('00020126580014br.gov.bcb.pix')
    expect(result.status).toBe('pending')

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://api.mercadopago.com/v1/payments')
    const headers = init!.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer TEST-token')
    expect(headers['x-idempotency-key']).toBe('idem-1')
    const body = JSON.parse(init!.body as string)
    expect(body.transaction_amount).toBe(25.9)
    expect(body.payment_method_id).toBe('pix')
    expect(body.payer.identification).toEqual({ type: 'CPF', number: '12345678909' })
  })

  it('lança erro tipado quando o provedor recusa', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ message: 'invalid token' }, 401))
    const provider = createMercadoPagoProvider({
      accessToken: 'ruim',
      webhookSecret: 's',
      fetchImpl,
    })
    await expect(provider.createPayment(INPUT)).rejects.toBeInstanceOf(PaymentProviderError)
  })

  it('valida a assinatura do webhook usando o manifesto documentado', async () => {
    const secret = 'segredo'
    const ts = Math.floor(Date.now() / 1000)
    const manifest = `id:999;request-id:req-1;ts:${ts};`
    const v1 = hmacSha256Hex(secret, manifest)

    const provider = createMercadoPagoProvider({
      accessToken: 't',
      webhookSecret: secret,
      fetchImpl: vi.fn(),
    })
    const result = await provider.verifyWebhook(
      { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': 'req-1' },
      JSON.stringify({ action: 'payment.updated', data: { id: 999 } }),
    )

    expect(result.valid).toBe(true)
    expect(result.providerPaymentId).toBe('999')
  })

  it('recusa assinatura adulterada', async () => {
    const ts = Math.floor(Date.now() / 1000)
    const provider = createMercadoPagoProvider({
      accessToken: 't',
      webhookSecret: 'segredo',
      fetchImpl: vi.fn(),
    })
    const result = await provider.verifyWebhook(
      { 'x-signature': `ts=${ts},v1=deadbeef`, 'x-request-id': 'req-1' },
      JSON.stringify({ data: { id: 999 } }),
    )
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('assinatura inválida')
  })

  it('recusa notificação antiga (proteção contra reenvio)', async () => {
    const secret = 'segredo'
    const ts = Math.floor(Date.now() / 1000) - 3600
    const v1 = hmacSha256Hex(secret, `id:999;request-id:req-1;ts:${ts};`)
    const provider = createMercadoPagoProvider({
      accessToken: 't',
      webhookSecret: secret,
      fetchImpl: vi.fn(),
    })
    const result = await provider.verifyWebhook(
      { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': 'req-1' },
      JSON.stringify({ data: { id: 999 } }),
    )
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('tolerância')
  })

  it('recusa webhook sem assinatura', async () => {
    const provider = createMercadoPagoProvider({ accessToken: 't', webhookSecret: 's', fetchImpl: vi.fn() })
    expect((await provider.verifyWebhook({}, '{}')).valid).toBe(false)
  })
})

describe('Stripe', () => {
  it('converte reais para centavos sem erro de ponto flutuante', () => {
    expect(toStripeAmount(25.9)).toBe(2590)
    expect(toStripeAmount(0.1 + 0.2)).toBe(30)
    expect(toStripeAmount(1234.56)).toBe(123456)
  })

  it('mapeia os status do provedor', () => {
    expect(mapStripeStatus('succeeded')).toBe('approved')
    expect(mapStripeStatus('processing')).toBe('processing')
    expect(mapStripeStatus('canceled')).toBe('canceled')
    expect(mapStripeStatus('requires_action')).toBe('pending')
  })

  it('envia payment intent form-urlencoded com idempotência', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ id: 'pi_123', status: 'requires_payment_method', client_secret: 'pi_123_secret' }),
    )
    const provider = createStripeProvider({
      secretKey: 'sk_test',
      webhookSecret: 'whsec',
      fetchImpl,
    })
    const result = await provider.createPayment({ ...INPUT, method: 'credit_card' })

    expect(result.providerPaymentId).toBe('pi_123')
    expect(result.checkoutUrl).toBe('pi_123_secret')

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://api.stripe.com/v1/payment_intents')
    const headers = init!.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(headers['idempotency-key']).toBe('idem-1')
    const form = new URLSearchParams(init!.body as string)
    expect(form.get('amount')).toBe('2590')
    expect(form.get('currency')).toBe('brl')
    expect(form.get('metadata[order_id]')).toBe(INPUT.orderId)
  })

  it('valida a assinatura no formato t=...,v1=...', async () => {
    const secret = 'whsec_teste'
    const ts = Math.floor(Date.now() / 1000)
    const body = JSON.stringify({
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_123', status: 'succeeded' } },
    })
    const v1 = hmacSha256Hex(secret, `${ts}.${body}`)

    const provider = createStripeProvider({ secretKey: 'sk', webhookSecret: secret, fetchImpl: vi.fn() })
    const result = await provider.verifyWebhook({ 'stripe-signature': `t=${ts},v1=${v1}` }, body)

    expect(result.valid).toBe(true)
    expect(result.eventId).toBe('evt_1')
    expect(result.providerPaymentId).toBe('pi_123')
    expect(result.status).toBe('approved')
  })

  it('recusa assinatura calculada sobre outro corpo', async () => {
    const secret = 'whsec_teste'
    const ts = Math.floor(Date.now() / 1000)
    const v1 = hmacSha256Hex(secret, `${ts}.{"outro":"corpo"}`)
    const provider = createStripeProvider({ secretKey: 'sk', webhookSecret: secret, fetchImpl: vi.fn() })

    const result = await provider.verifyWebhook(
      { 'stripe-signature': `t=${ts},v1=${v1}` },
      JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded', data: { object: {} } }),
    )
    expect(result.valid).toBe(false)
  })
})

describe('Asaas', () => {
  it('mapeia os status do provedor', () => {
    expect(mapAsaasStatus('RECEIVED')).toBe('approved')
    expect(mapAsaasStatus('CONFIRMED')).toBe('approved')
    expect(mapAsaasStatus('OVERDUE')).toBe('expired')
    expect(mapAsaasStatus('REFUNDED')).toBe('refunded')
    expect(mapAsaasStatus('PENDING')).toBe('pending')
  })

  it('formata o vencimento como YYYY-MM-DD', () => {
    expect(toAsaasDueDate(new Date('2026-08-19T15:00:00Z'))).toBe('2026-08-19')
  })

  it('exige o identificador do cliente antes de cobrar', async () => {
    const provider = createAsaasProvider({ apiKey: 'k', webhookToken: 't', fetchImpl: vi.fn() })
    await expect(provider.createPayment(INPUT)).rejects.toBeInstanceOf(PaymentProviderError)
  })

  it('cria a cobrança e busca o QR do PIX no segundo endpoint', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith('/pixQrCode')) {
        return jsonResponse({ payload: '00020126PIX', encodedImage: 'aW1n' })
      }
      return jsonResponse({ id: 'pay_1', status: 'PENDING', invoiceUrl: 'https://asaas/i/1', dueDate: '2026-08-19' })
    })

    const provider = createAsaasProvider({
      apiKey: 'chave',
      webhookToken: 'token',
      fetchImpl,
      now: () => new Date('2026-08-18T12:00:00Z'),
    })
    const result = await provider.createPayment({ ...INPUT, providerCustomerId: 'cus_1' })

    expect(result.providerPaymentId).toBe('pay_1')
    expect(result.qrCode).toBe('00020126PIX')
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    const [, init] = fetchImpl.mock.calls[0]!
    const headers = init!.headers as Record<string, string>
    expect(headers.access_token).toBe('chave')
    const body = JSON.parse(init!.body as string)
    expect(body.billingType).toBe('PIX')
    expect(body.dueDate).toBe('2026-08-19')
    expect(body.externalReference).toBe(INPUT.orderId)
  })

  it('autentica o webhook pelo token do cabeçalho', async () => {
    const provider = createAsaasProvider({ apiKey: 'k', webhookToken: 'token-certo', fetchImpl: vi.fn() })
    const body = JSON.stringify({
      id: 'evt_asaas_1',
      event: 'PAYMENT_RECEIVED',
      payment: { id: 'pay_1', status: 'RECEIVED' },
    })

    const ok = await provider.verifyWebhook({ 'asaas-access-token': 'token-certo' }, body)
    expect(ok.valid).toBe(true)
    expect(ok.status).toBe('approved')

    const ruim = await provider.verifyWebhook({ 'asaas-access-token': 'token-errado' }, body)
    expect(ruim.valid).toBe(false)

    const ausente = await provider.verifyWebhook({}, body)
    expect(ausente.valid).toBe(false)
  })
})
