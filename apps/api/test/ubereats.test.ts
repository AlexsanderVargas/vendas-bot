import { describe, expect, it, vi } from 'vitest'
import {
  createUberEatsChannel,
  fromMinorUnits,
  mapUberOrderType,
  normalizeUberOrder,
  uberSignature,
} from '../src/modules/integrations/channels/ubereats.js'
import { ChannelError } from '../src/modules/integrations/channels/types.js'

/** Transporte mockado. NÃO substitui homologação com o Uber Eats. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const CREDENTIALS = {
  clientId: 'uber-client',
  clientSecret: 'uber-secret',
  externalStoreId: 'store-xyz',
}

const PEDIDO_UBER = {
  id: 'ord_123',
  display_id: 'A1B2',
  type: 'DELIVERY_BY_UBER',
  placed_at: '2026-08-18T12:00:00Z',
  eater: { first_name: 'Cliente', last_name: 'A', phone: '+5551999990001' },
  cart: {
    items: [
      {
        id: 'uber-item-id',
        external_data: 'UB-XSALADA',
        title: 'X-Salada',
        quantity: 2,
        price: { unit_price: { amount: 2590 }, total_price: { amount: 5180 } },
        special_instructions: 'sem cebola',
        selected_modifier_groups: [
          {
            title: 'Ponto da carne',
            selected_items: [{ title: 'Bem passada', quantity: 1, price: { unit_price: { amount: 250 } } }],
          },
        ],
      },
    ],
  },
  payment: {
    charges: {
      sub_total: { amount: 5180 },
      total: { amount: 5480 },
      delivery_fee: { amount: 800 },
      promotion_applied: { amount: 500 },
    },
  },
  deliveries: [
    {
      location: {
        street_address: 'Rua A, 100', city: 'Porto Alegre', state: 'RS',
        postal_code: '90010000',
      },
    },
  ],
}

describe('fromMinorUnits', () => {
  it('converte centavos para reais', () => {
    expect(fromMinorUnits(2590)).toBe(25.9)
    expect(fromMinorUnits(5480)).toBe(54.8)
  })
  it('trata ausência e valor inválido como zero', () => {
    expect(fromMinorUnits(undefined)).toBe(0)
    expect(fromMinorUnits('abc')).toBe(0)
  })
  it('não herda erro de ponto flutuante', () => {
    expect(fromMinorUnits(1)).toBe(0.01)
    expect(fromMinorUnits(333)).toBe(3.33)
  })
})

describe('mapUberOrderType', () => {
  it('PICK_UP vira retirada', () => {
    expect(mapUberOrderType('PICK_UP')).toBe('takeaway')
  })
  it('entrega pela Uber vira delivery', () => {
    expect(mapUberOrderType('DELIVERY_BY_UBER')).toBe('delivery')
  })
})

describe('normalizeUberOrder', () => {
  it('usa external_data como identificador do item', () => {
    // O id do Uber muda entre pedidos; external_data é o código da loja.
    expect(normalizeUberOrder(PEDIDO_UBER).items[0]!.externalItemId).toBe('UB-XSALADA')
  })

  it('converte todos os valores de centavos para reais', () => {
    const order = normalizeUberOrder(PEDIDO_UBER)
    expect(order.subtotal).toBe(51.8)
    expect(order.total).toBe(54.8)
    expect(order.deliveryFee).toBe(8)
    expect(order.items[0]!.unitPrice).toBe(25.9)
  })

  it('trata promoção como desconto positivo', () => {
    expect(normalizeUberOrder(PEDIDO_UBER).discount).toBe(5)
  })

  it('achata os grupos de modificadores em opcionais', () => {
    const order = normalizeUberOrder(PEDIDO_UBER)
    expect(order.items[0]!.options).toEqual([
      { name: 'Bem passada', priceDelta: 2.5, groupName: 'Ponto da carne' },
    ])
  })

  it('marca o pedido como pago (Uber cobra no app)', () => {
    expect(normalizeUberOrder(PEDIDO_UBER).paymentStatus).toBe('paid')
  })

  it('monta o nome do cliente a partir de primeiro e último nome', () => {
    expect(normalizeUberOrder(PEDIDO_UBER).customer.name).toBe('Cliente A')
  })

  it('traduz o endereço de entrega', () => {
    expect(normalizeUberOrder(PEDIDO_UBER).deliveryAddress).toMatchObject({
      street: 'Rua A, 100',
      city: 'Porto Alegre',
    })
  })

  it('retirada não traz endereço', () => {
    const order = normalizeUberOrder({ ...PEDIDO_UBER, type: 'PICK_UP', deliveries: [] })
    expect(order.channel).toBe('takeaway')
    expect(order.deliveryAddress).toBeNull()
  })

  it('tolera pedido sem carrinho ou sem cobranças', () => {
    const order = normalizeUberOrder({ id: 'x' })
    expect(order.items).toEqual([])
    expect(order.total).toBe(0)
    expect(order.customer.name).toBeNull()
  })
})

describe('cliente Uber Eats', () => {
  it('autentica com os escopos necessários', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ access_token: 'tok-uber', expires_in: 2592000, token_type: 'Bearer' }),
    )

    const channel = createUberEatsChannel({ credentials: CREDENTIALS, fetchImpl })
    const token = await channel.authenticate()

    expect(token.accessToken).toBe('tok-uber')

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://auth.uber.com/oauth/v2/token')
    const form = new URLSearchParams(init!.body as string)
    expect(form.get('grant_type')).toBe('client_credentials')
    expect(form.get('scope')).toContain('eats.order')
  })

  it('não faz polling (o canal é por webhook)', async () => {
    const fetchImpl = vi.fn()
    const channel = createUberEatsChannel({ credentials: CREDENTIALS, fetchImpl })
    expect(await channel.pollEvents()).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('valida a assinatura do webhook e extrai o pedido', async () => {
    const body = JSON.stringify({
      event_id: 'evt-uber-1',
      event_type: 'orders.notification',
      meta: { resource_id: 'ord_123', status: 'pos' },
    })
    const channel = createUberEatsChannel({
      credentials: { ...CREDENTIALS, webhookSecret: 'webhook-secret' },
      fetchImpl: vi.fn(),
    })

    const result = await channel.verifyWebhook(
      { 'x-uber-signature': uberSignature('webhook-secret', body) },
      body,
    )

    expect(result.valid).toBe(true)
    expect(result.event).toMatchObject({ eventId: 'evt-uber-1', externalOrderId: 'ord_123' })
  })

  it('recusa assinatura calculada sobre outro corpo', async () => {
    const channel = createUberEatsChannel({
      credentials: { ...CREDENTIALS, webhookSecret: 'webhook-secret' },
      fetchImpl: vi.fn(),
    })
    const result = await channel.verifyWebhook(
      { 'x-uber-signature': uberSignature('webhook-secret', '{"outro":"corpo"}') },
      JSON.stringify({ event_id: 'evt-1', meta: {} }),
    )
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('assinatura inválida')
  })

  it('recusa webhook sem assinatura', async () => {
    const channel = createUberEatsChannel({ credentials: CREDENTIALS, fetchImpl: vi.fn() })
    expect((await channel.verifyWebhook({}, '{}')).valid).toBe(false)
  })

  it('cai para o client secret quando não há segredo de webhook próprio', async () => {
    const body = JSON.stringify({ event_id: 'e', meta: {} })
    const channel = createUberEatsChannel({ credentials: CREDENTIALS, fetchImpl: vi.fn() })
    const result = await channel.verifyWebhook(
      { 'x-uber-signature': uberSignature(CREDENTIALS.clientSecret, body) },
      body,
    )
    expect(result.valid).toBe(true)
  })

  it('busca e normaliza o pedido', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('oauth/v2/token')) return jsonResponse({ access_token: 't', expires_in: 3600 })
      return jsonResponse(PEDIDO_UBER)
    })

    const channel = createUberEatsChannel({ credentials: CREDENTIALS, fetchImpl })
    const order = await channel.fetchOrder('ord_123')

    expect(order.externalOrderId).toBe('ord_123')
    expect(fetchImpl.mock.calls.some(([url]) => url.includes('/v2/eats/order/ord_123'))).toBe(true)
  })

  it('aceita o pedido pelo endpoint de POS', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('oauth/v2/token')) return jsonResponse({ access_token: 't', expires_in: 3600 })
      return jsonResponse({})
    })

    const channel = createUberEatsChannel({ credentials: CREDENTIALS, fetchImpl })
    await channel.applyAction('ord_123', 'confirm')

    expect(fetchImpl.mock.calls.some(([url]) => url.includes('accept_pos_order'))).toBe(true)
  })

  it('preparo e despacho não geram chamada (a Uber acompanha por conta própria)', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({}))
    const channel = createUberEatsChannel({ credentials: CREDENTIALS, fetchImpl })

    await channel.applyAction('ord_123', 'start_preparation')
    await channel.applyAction('ord_123', 'ready')
    await channel.applyAction('ord_123', 'dispatch')

    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('envia motivo e parte responsável no cancelamento', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('oauth/v2/token')) return jsonResponse({ access_token: 't', expires_in: 3600 })
      return jsonResponse({})
    })

    const channel = createUberEatsChannel({ credentials: CREDENTIALS, fetchImpl })
    await channel.applyAction('ord_123', 'cancel', 'OUT_OF_ITEMS')

    const call = fetchImpl.mock.calls.find(([url]) => url.includes('/cancel'))!
    const body = JSON.parse(call[1]!.body as string)
    expect(body.reason).toBe('OUT_OF_ITEMS')
    expect(body.cancelling_party).toBe('RESTAURANT')
  })

  it('pausa e reabre a loja', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('oauth/v2/token')) return jsonResponse({ access_token: 't', expires_in: 3600 })
      return jsonResponse({})
    })

    const channel = createUberEatsChannel({ credentials: CREDENTIALS, fetchImpl })
    await channel.setStoreAvailability(false, 'Cozinha lotada')
    await channel.setStoreAvailability(true)

    const statusCalls = fetchImpl.mock.calls.filter(([url]) => url.includes('/status'))
    expect(JSON.parse(statusCalls[0]![1]!.body as string).status).toBe('PAUSED')
    expect(JSON.parse(statusCalls[1]![1]!.body as string).status).toBe('ONLINE')
  })

  it('lança erro tipado quando a autenticação falha', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ error: 'invalid_client' }, 401),
    )
    const channel = createUberEatsChannel({ credentials: CREDENTIALS, fetchImpl })
    await expect(channel.authenticate()).rejects.toBeInstanceOf(ChannelError)
  })
})
