import { describe, expect, it, vi } from 'vitest'
import {
  createIfoodChannel,
  mapIfoodOrderType,
  normalizeIfoodEventCode,
  normalizeIfoodOrder,
} from '../src/modules/integrations/channels/ifood.js'
import { ChannelError } from '../src/modules/integrations/channels/types.js'

/**
 * Transporte HTTP mockado. Estes testes NÃO substituem homologação com o
 * iFood: nenhuma credencial real foi usada.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const CREDENTIALS = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  externalStoreId: 'merchant-abc',
}

const PEDIDO_IFOOD = {
  id: 'a1b2c3',
  displayId: '4821',
  orderType: 'DELIVERY',
  createdAt: '2026-08-18T12:00:00Z',
  customer: { name: 'Cliente A', phone: { number: '5551999990001' } },
  items: [
    {
      id: 'item-uuid',
      externalCode: 'IFD-XSALADA',
      name: 'X-Salada',
      quantity: 2,
      unitPrice: 25.9,
      observations: 'sem cebola',
      options: [{ name: 'Bem passada', unitPrice: 2.5 }],
    },
  ],
  total: { subTotal: 56.8, deliveryFee: 8.0, benefits: 5.0, orderAmount: 59.8 },
  delivery: {
    deliveryAddress: {
      streetName: 'Rua A', streetNumber: '100', neighborhood: 'Centro',
      city: 'Porto Alegre', state: 'RS', postalCode: '90010000',
    },
  },
  payments: { prepaid: 59.8, pending: 0 },
}

describe('normalizeIfoodEventCode', () => {
  it('normaliza para maiúsculas sem espaços', () => {
    expect(normalizeIfoodEventCode(' plc ')).toBe('PLC')
  })
})

describe('mapIfoodOrderType', () => {
  it('TAKEOUT vira retirada', () => {
    expect(mapIfoodOrderType('TAKEOUT')).toBe('takeaway')
  })
  it('DELIVERY vira entrega', () => {
    expect(mapIfoodOrderType('DELIVERY')).toBe('delivery')
  })
  it('tipo desconhecido cai para entrega', () => {
    expect(mapIfoodOrderType('QUALQUER')).toBe('delivery')
  })
})

describe('normalizeIfoodOrder', () => {
  it('usa externalCode como identificador do item', () => {
    // O id do iFood muda entre pedidos; o externalCode é o que o restaurante
    // cadastrou e casa com o nosso catálogo.
    const order = normalizeIfoodOrder(PEDIDO_IFOOD)
    expect(order.items[0]!.externalItemId).toBe('IFD-XSALADA')
  })

  it('traduz totais mantendo os valores do parceiro', () => {
    const order = normalizeIfoodOrder(PEDIDO_IFOOD)
    expect(order.subtotal).toBe(56.8)
    expect(order.discount).toBe(5)
    expect(order.deliveryFee).toBe(8)
    expect(order.total).toBe(59.8)
  })

  it('trata benefits como desconto', () => {
    const order = normalizeIfoodOrder({
      ...PEDIDO_IFOOD,
      total: { subTotal: 100, deliveryFee: 0, benefits: 20, orderAmount: 80 },
    })
    expect(order.discount).toBe(20)
  })

  it('pedido pré-pago entra como pago', () => {
    expect(normalizeIfoodOrder(PEDIDO_IFOOD).paymentStatus).toBe('paid')
  })

  it('pagamento na entrega entra como pendente', () => {
    const order = normalizeIfoodOrder({
      ...PEDIDO_IFOOD,
      payments: { prepaid: 0, pending: 59.8 },
    })
    expect(order.paymentStatus).toBe('pending')
  })

  it('traduz o endereço de entrega', () => {
    const order = normalizeIfoodOrder(PEDIDO_IFOOD)
    expect(order.deliveryAddress).toMatchObject({
      street: 'Rua A',
      number: '100',
      city: 'Porto Alegre',
    })
  })

  it('retirada não traz endereço', () => {
    const order = normalizeIfoodOrder({ ...PEDIDO_IFOOD, orderType: 'TAKEOUT', delivery: {} })
    expect(order.channel).toBe('takeaway')
    expect(order.deliveryAddress).toBeNull()
  })

  it('preserva observações e opcionais do item', () => {
    const order = normalizeIfoodOrder(PEDIDO_IFOOD)
    expect(order.items[0]!.notes).toBe('sem cebola')
    expect(order.items[0]!.options).toEqual([
      { name: 'Bem passada', priceDelta: 2.5, groupName: null },
    ])
  })

  it('tolera pedido sem itens ou sem totais', () => {
    const order = normalizeIfoodOrder({ id: 'x' })
    expect(order.items).toEqual([])
    expect(order.total).toBe(0)
  })
})

describe('cliente iFood', () => {
  it('autentica no formato documentado e guarda o token', async () => {
    const salvos: unknown[] = []
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ accessToken: 'tok-123', expiresIn: 3600, type: 'bearer' }),
    )

    const channel = createIfoodChannel({
      credentials: CREDENTIALS,
      fetchImpl,
      onTokenRefreshed: async (token) => {
        salvos.push(token)
      },
    })
    const token = await channel.authenticate()

    expect(token.accessToken).toBe('tok-123')
    expect(salvos).toHaveLength(1)

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://merchant-api.ifood.com.br/authentication/v1.0/oauth/token')
    const form = new URLSearchParams(init!.body as string)
    expect(form.get('grantType')).toBe('client_credentials')
    expect(form.get('clientId')).toBe('client-id')
  })

  it('reaproveita token válido em vez de reautenticar', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('oauth/token')) return jsonResponse({ accessToken: 'novo', expiresIn: 3600 })
      return new Response(null, { status: 204 })
    })

    const channel = createIfoodChannel({
      credentials: {
        ...CREDENTIALS,
        accessToken: 'token-em-cache',
        tokenExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
      fetchImpl,
    })
    await channel.pollEvents()

    expect(fetchImpl.mock.calls.every(([url]) => !url.includes('oauth/token'))).toBe(true)
  })

  it('reautentica quando o token em cache está vencido', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('oauth/token')) return jsonResponse({ accessToken: 'novo', expiresIn: 3600 })
      return new Response(null, { status: 204 })
    })

    const channel = createIfoodChannel({
      credentials: {
        ...CREDENTIALS,
        accessToken: 'vencido',
        tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
      },
      fetchImpl,
    })
    await channel.pollEvents()

    expect(fetchImpl.mock.calls.some(([url]) => url.includes('oauth/token'))).toBe(true)
  })

  it('trata 204 do polling como ausência de eventos, não como erro', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('oauth/token')) return jsonResponse({ accessToken: 't', expiresIn: 3600 })
      return new Response(null, { status: 204 })
    })

    const channel = createIfoodChannel({ credentials: CREDENTIALS, fetchImpl })
    expect(await channel.pollEvents()).toEqual([])
  })

  it('normaliza os eventos do polling e envia o merchant no cabeçalho', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('oauth/token')) return jsonResponse({ accessToken: 't', expiresIn: 3600 })
      return jsonResponse([{ id: 'evt-1', code: 'plc', orderId: 'a1b2c3' }])
    })

    const channel = createIfoodChannel({ credentials: CREDENTIALS, fetchImpl })
    const events = await channel.pollEvents()

    expect(events).toEqual([
      { eventId: 'evt-1', code: 'PLC', externalOrderId: 'a1b2c3', raw: { id: 'evt-1', code: 'plc', orderId: 'a1b2c3' } },
    ])

    const pollCall = fetchImpl.mock.calls.find(([url]) => url.includes('events:polling'))!
    const headers = pollCall[1]!.headers as Record<string, string>
    expect(headers['x-polling-merchants']).toBe('merchant-abc')
  })

  it('não chama acknowledgment com lista vazia', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ accessToken: 't', expiresIn: 3600 }),
    )
    const channel = createIfoodChannel({ credentials: CREDENTIALS, fetchImpl })
    await channel.acknowledgeEvents([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('confirma os eventos no formato de lista de ids', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('oauth/token')) return jsonResponse({ accessToken: 't', expiresIn: 3600 })
      return jsonResponse({})
    })

    const channel = createIfoodChannel({ credentials: CREDENTIALS, fetchImpl })
    await channel.acknowledgeEvents(['evt-1', 'evt-2'])

    const ackCall = fetchImpl.mock.calls.find(([url]) => url.includes('acknowledgment'))!
    expect(JSON.parse(ackCall[1]!.body as string)).toEqual([{ id: 'evt-1' }, { id: 'evt-2' }])
  })

  it('busca e normaliza o pedido', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('oauth/token')) return jsonResponse({ accessToken: 't', expiresIn: 3600 })
      return jsonResponse(PEDIDO_IFOOD)
    })

    const channel = createIfoodChannel({ credentials: CREDENTIALS, fetchImpl })
    const order = await channel.fetchOrder('a1b2c3')

    expect(order.externalOrderId).toBe('a1b2c3')
    expect(order.displayId).toBe('4821')
  })

  it('usa o caminho correto de cada ação do pedido', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('oauth/token')) return jsonResponse({ accessToken: 't', expiresIn: 3600 })
      return jsonResponse({})
    })

    const channel = createIfoodChannel({ credentials: CREDENTIALS, fetchImpl })
    await channel.applyAction('a1b2c3', 'confirm')
    await channel.applyAction('a1b2c3', 'dispatch')

    const urls = fetchImpl.mock.calls.map(([url]) => url)
    expect(urls).toContain('https://merchant-api.ifood.com.br/order/v1.0/orders/a1b2c3/confirm')
    expect(urls).toContain('https://merchant-api.ifood.com.br/order/v1.0/orders/a1b2c3/dispatch')
  })

  it('envia justificativa no cancelamento', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('oauth/token')) return jsonResponse({ accessToken: 't', expiresIn: 3600 })
      return jsonResponse({})
    })

    const channel = createIfoodChannel({ credentials: CREDENTIALS, fetchImpl })
    await channel.applyAction('a1b2c3', 'cancel', 'Produto em falta')

    const cancelCall = fetchImpl.mock.calls.find(([url]) => url.includes('requestCancellation'))!
    expect(JSON.parse(cancelCall[1]!.body as string).reason).toBe('Produto em falta')
  })

  it('pausar a loja cria interrupção com janela de tempo', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('oauth/token')) return jsonResponse({ accessToken: 't', expiresIn: 3600 })
      return jsonResponse({ id: 'int-1' })
    })

    const channel = createIfoodChannel({ credentials: CREDENTIALS, fetchImpl })
    await channel.setStoreAvailability(false, 'Cozinha lotada')

    const call = fetchImpl.mock.calls.find(([url]) => url.includes('interruptions'))!
    const body = JSON.parse(call[1]!.body as string)
    expect(body.description).toBe('Cozinha lotada')
    expect(Date.parse(body.end)).toBeGreaterThan(Date.parse(body.start))
  })

  it('reabrir a loja remove as interrupções ativas', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('oauth/token')) return jsonResponse({ accessToken: 't', expiresIn: 3600 })
      if (init?.method === 'GET') return jsonResponse([{ id: 'int-1' }, { id: 'int-2' }])
      return jsonResponse({})
    })

    const channel = createIfoodChannel({ credentials: CREDENTIALS, fetchImpl })
    await channel.setStoreAvailability(true)

    const deletes = fetchImpl.mock.calls.filter(([, init]) => init?.method === 'DELETE')
    expect(deletes).toHaveLength(2)
  })

  it('lança erro tipado quando a autenticação falha', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ error: 'invalid_client' }, 401),
    )
    const channel = createIfoodChannel({ credentials: CREDENTIALS, fetchImpl })
    await expect(channel.authenticate()).rejects.toBeInstanceOf(ChannelError)
  })

  it('declara que não usa webhook', async () => {
    const channel = createIfoodChannel({ credentials: CREDENTIALS, fetchImpl: vi.fn() })
    const result = await channel.verifyWebhook({}, '{}')
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('polling')
  })
})
