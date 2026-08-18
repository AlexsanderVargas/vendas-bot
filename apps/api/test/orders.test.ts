import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { googleMapsLink, haversineMeters, wazeLink } from '@vendas-bot/shared'
import { mapCheckoutError, toOrder, toOrderItem } from '../src/modules/orders/service.js'
import { createFakeSupabase, type TableRows } from './fake-supabase.js'
import { bearer, buildTestServer, customerToken, TENANT_A } from './helpers.js'

const TABLES: TableRows = {
  tenants: [{ id: TENANT_A, slug: 'lancheria-t1', is_active: true }],
}

const OK_ORDER = {
  id: '50000000-0000-0000-0000-000000000001',
  orderNumber: 7,
  status: 'placed',
  channel: 'takeaway',
  subtotal: '56.80',
  deliveryFee: '0',
  total: '56.80',
  etaMinutes: 40,
}

describe('mapCheckoutError', () => {
  it('mapeia recusa por autorização para 403', () => {
    expect(mapCheckoutError('nao_autorizado').status).toBe(403)
  })
  it('mapeia carrinho vazio para 400', () => {
    expect(mapCheckoutError('carrinho_vazio').status).toBe(400)
  })
  it('mapeia produto indisponível para 409', () => {
    expect(mapCheckoutError('produto_indisponivel').status).toBe(409)
  })
  it('mapeia qualquer indisponibilidade de entrega para 409 com mensagem própria', () => {
    const mapped = mapCheckoutError('entrega_indisponivel:fora_da_area')
    expect(mapped.status).toBe(409)
    expect(mapped.message).toBe('Endereço fora da área de entrega.')
  })
  it('usa mensagem genérica para erro desconhecido', () => {
    const mapped = mapCheckoutError('algo_novo')
    expect(mapped.status).toBe(400)
    expect(mapped.message).toBe('Não foi possível concluir o pedido.')
  })
})

describe('toOrderItem / toOrder', () => {
  it('converte numéricos e opcionais do item', () => {
    const item = toOrderItem({
      id: 'item-1', product_name: 'X-Salada', unit_price: '28.40',
      quantity: '2.000', total: '56.80', notes: null,
      selected_options: [{ groupName: 'Ponto', optionName: 'Bem passada', priceDelta: 2.5 }],
    })
    expect(item.unitPrice).toBe(28.4)
    expect(item.quantity).toBe(2)
    expect(item.total).toBe(56.8)
    expect(item.selectedOptions[0]!.optionName).toBe('Bem passada')
  })

  it('tolera selected_options malformado', () => {
    const item = toOrderItem({
      id: 'i', product_name: 'p', unit_price: 1, quantity: 1, total: 1,
      notes: null, selected_options: 'lixo',
    })
    expect(item.selectedOptions).toEqual([])
  })

  it('monta o pedido com os itens agregados', () => {
    const order = toOrder(
      {
        id: 'o1', order_number: '7', status: 'placed', payment_status: 'pending',
        channel: 'delivery', subtotal: '56.80', discount: '0', delivery_fee: '9.90',
        total: '66.70', notes: null, delivery_address: { street: 'Rua A' },
        created_at: '2026-08-18T00:00:00Z', placed_at: '2026-08-18T00:00:00Z', delivered_at: null,
      },
      [{ id: 'i1', product_name: 'X', unit_price: '28.40', quantity: '2', total: '56.80', notes: null, selected_options: [] }],
    )
    expect(order.orderNumber).toBe(7)
    expect(order.total).toBe(66.7)
    expect(order.items).toHaveLength(1)
    expect(order.deliveryAddress).toEqual({ street: 'Rua A' })
  })
})

describe('links de navegação (retirada)', () => {
  it('gera link do Google Maps por coordenadas', () => {
    const link = googleMapsLink({ latitude: -30.0346, longitude: -51.2177 })
    expect(link).toContain('destination=-30.0346%2C-51.2177')
  })
  it('gera link do Google Maps por endereço textual', () => {
    expect(googleMapsLink('Av. Ipiranga, 1000, Porto Alegre')).toContain('destination=Av.+Ipiranga')
  })
  it('gera link do Waze com navegação ativada', () => {
    expect(wazeLink({ latitude: -30.0346, longitude: -51.2177 })).toBe(
      'https://waze.com/ul?ll=-30.0346%2C-51.2177&navigate=yes',
    )
  })
  it('calcula distância aproximada entre dois pontos', () => {
    const metros = haversineMeters(
      { latitude: -30.0346, longitude: -51.2177 },
      { latitude: -30.03, longitude: -51.21 },
    )
    expect(metros).toBeGreaterThan(500)
    expect(metros).toBeLessThan(1500)
  })
  it('devolve zero para o mesmo ponto', () => {
    const ponto = { latitude: -30.0346, longitude: -51.2177 }
    expect(haversineMeters(ponto, ponto)).toBe(0)
  })
})

describe('POST /api/v1/orders/checkout', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = await buildTestServer()
    app.addHook('onRequest', async (request) => {
      request.supabase = createFakeSupabase(TABLES, {
        checkout_order: (params) => {
          const items = (params.p_items as unknown[]) ?? []
          if (items.length === 0) return { ok: false, error: 'carrinho_vazio', order: null }
          if (params.p_channel === 'delivery' && !params.p_address_id) {
            return { ok: false, error: 'endereco_invalido', order: null }
          }
          return { ok: true, error: null, order: OK_ORDER }
        },
      })
    })
  })
  afterAll(async () => {
    await app.close()
  })

  it('exige autenticação', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/checkout',
      payload: { tenantSlug: 'lancheria-t1', channel: 'takeaway', items: [] },
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejeita carrinho vazio no contrato de entrada', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/checkout',
      headers: bearer(await customerToken()),
      payload: { tenantSlug: 'lancheria-t1', channel: 'takeaway', items: [] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejeita canal inválido', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/checkout',
      headers: bearer(await customerToken()),
      payload: {
        tenantSlug: 'lancheria-t1', channel: 'drive_thru',
        items: [{ productId: '20000000-0000-0000-0000-000000000001', quantity: 1, optionIds: [] }],
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('recusa cliente sem cadastro no estabelecimento', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/checkout',
      headers: bearer(await customerToken()),
      payload: {
        tenantSlug: 'lancheria-t1', channel: 'takeaway',
        items: [{ productId: '20000000-0000-0000-0000-000000000001', quantity: 1, optionIds: [] }],
      },
    })
    expect(res.statusCode).toBe(403)
  })

  it('exige autenticação para o histórico', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/orders' })
    expect(res.statusCode).toBe(401)
  })
})

describe('mapAdvanceError', () => {
  it('mapeia pedido inexistente para 404', async () => {
    const { mapAdvanceError } = await import('../src/modules/orders/service.js')
    expect(mapAdvanceError('pedido_nao_encontrado').status).toBe(404)
  })
  it('mapeia falta de autorização para 403', async () => {
    const { mapAdvanceError } = await import('../src/modules/orders/service.js')
    expect(mapAdvanceError('nao_autorizado').status).toBe(403)
  })
  it('mapeia transição inválida para 409', async () => {
    const { mapAdvanceError } = await import('../src/modules/orders/service.js')
    const mapped = mapAdvanceError('transicao_invalida')
    expect(mapped.status).toBe(409)
    expect(mapped.message).toContain('não é permitida')
  })
})

describe('máquina de transição compartilhada', () => {
  it('espelha as regras da função SQL can_transition_order', async () => {
    const { canTransition } = await import('@vendas-bot/shared')
    expect(canTransition('placed', 'confirmed')).toBe(true)
    expect(canTransition('placed', 'preparing')).toBe(false)
    expect(canTransition('confirmed', 'preparing')).toBe(true)
    expect(canTransition('ready', 'out_for_delivery')).toBe(true)
    expect(canTransition('delivered', 'completed')).toBe(true)
    expect(canTransition('completed', 'placed')).toBe(false)
    expect(canTransition('canceled', 'confirmed')).toBe(false)
  })
})
