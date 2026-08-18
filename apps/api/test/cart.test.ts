import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { toCartItems } from '../src/modules/cart/service.js'
import { buildLineKey } from '@vendas-bot/shared'
import { createFakeSupabase, type TableRows } from './fake-supabase.js'
import { bearer, buildTestServer, customerToken, TENANT_A } from './helpers.js'

const TABLES: TableRows = {
  tenants: [{ id: TENANT_A, slug: 'lancheria-t1', is_active: true }],
}

const RPCS = {
  suggest_upsell: (params: Record<string, unknown>) => {
    const exclude = (params.p_exclude_product_ids as string[]) ?? []
    const categories = (params.p_category_ids as string[]) ?? []
    const limit = Number(params.p_limit ?? 3)
    const candidates = [
      { id: '20000000-0000-0000-0000-0000000000b1', name: 'Guaraná 350ml', price: '7.00', image_url: null, description: null },
    ]
    if (categories.length === 0) return []
    return candidates.filter((row) => !exclude.includes(row.id)).slice(0, limit)
  },
}

describe('toCartItems', () => {
  it('normaliza quantidade numérica e opcionais', () => {
    expect(
      toCartItems([
        {
          line_key: 'prod-1::opt-a',
          product_id: 'prod-1',
          quantity: '2.000',
          notes: 'sem cebola',
          selected_options: [
            { groupId: 'g1', groupName: 'Ponto', optionId: 'o1', optionName: 'Ao ponto', priceDelta: 0 },
          ],
        },
      ]),
    ).toEqual([
      {
        lineKey: 'prod-1::opt-a',
        productId: 'prod-1',
        quantity: 2,
        notes: 'sem cebola',
        selectedOptions: [
          { groupId: 'g1', groupName: 'Ponto', optionId: 'o1', optionName: 'Ao ponto', priceDelta: 0 },
        ],
      },
    ])
  })

  it('tolera selected_options ausente ou malformado', () => {
    const [item] = toCartItems([
      { line_key: 'k', product_id: 'p', quantity: 1, notes: null, selected_options: null },
    ])
    expect(item!.selectedOptions).toEqual([])
  })
})

describe('buildLineKey', () => {
  it('produz a mesma chave independente da ordem das opções', () => {
    const a = buildLineKey('prod-1', [{ optionId: 'b' }, { optionId: 'a' }])
    const b = buildLineKey('prod-1', [{ optionId: 'a' }, { optionId: 'b' }])
    expect(a).toBe(b)
  })
  it('usa apenas o produto quando não há opções', () => {
    expect(buildLineKey('prod-1', [])).toBe('prod-1')
  })
  it('distingue combinações diferentes de opções', () => {
    expect(buildLineKey('prod-1', [{ optionId: 'a' }])).not.toBe(
      buildLineKey('prod-1', [{ optionId: 'b' }]),
    )
  })
})

describe('rotas de carrinho e sugestões', () => {
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

  it('exige autenticação para ler o carrinho', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/cart?tenantSlug=lancheria-t1' })
    expect(res.statusCode).toBe(401)
  })

  it('devolve carrinho vazio quando o cliente ainda não tem cadastro', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/cart?tenantSlug=lancheria-t1',
      headers: bearer(await customerToken()),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: null, tenantSlug: 'lancheria-t1', items: [], updatedAt: null })
  })

  it('rejeita sincronização com linhas duplicadas', async () => {
    const item = {
      lineKey: 'prod-1', productId: '20000000-0000-0000-0000-000000000001',
      quantity: 1, notes: null, selectedOptions: [],
    }
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/cart',
      headers: bearer(await customerToken()),
      payload: { tenantSlug: 'lancheria-t1', items: [item, item] },
    })
    expect([400, 403]).toContain(res.statusCode)
  })

  it('rejeita quantidade zero na sincronização', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/cart',
      headers: bearer(await customerToken()),
      payload: {
        tenantSlug: 'lancheria-t1',
        items: [{ lineKey: 'k', productId: '20000000-0000-0000-0000-000000000001', quantity: 0, notes: null, selectedOptions: [] }],
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('sugere upsell conforme as categorias do carrinho', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/public/suggestions',
      payload: {
        tenantSlug: 'lancheria-t1',
        categoryIds: ['60000000-0000-0000-0000-000000000001'],
        excludeProductIds: [],
        limit: 3,
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([
      {
        id: '20000000-0000-0000-0000-0000000000b1',
        name: 'Guaraná 350ml',
        description: null,
        price: 7,
        imageUrl: null,
      },
    ])
  })

  it('não sugere item que já está no carrinho', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/public/suggestions',
      payload: {
        tenantSlug: 'lancheria-t1',
        categoryIds: ['60000000-0000-0000-0000-000000000001'],
        excludeProductIds: ['20000000-0000-0000-0000-0000000000b1'],
        limit: 3,
      },
    })
    expect(res.json()).toEqual([])
  })

  it('sugestões dispensam autenticação', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/public/suggestions',
      payload: { tenantSlug: 'lancheria-t1', categoryIds: [], excludeProductIds: [], limit: 3 },
    })
    expect(res.statusCode).toBe(200)
  })
})
