import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { getPublicMenu, parseLocation } from '@vendas-bot/shared'
import { createFakeSupabase, type TableRows } from './fake-supabase.js'
import { buildTestServer, TENANT_A } from './helpers.js'

const FIXTURE: TableRows = {
  tenants: [
    {
      id: TENANT_A,
      slug: 'lancheria-t1',
      name: 'Lancheria T1',
      delivery_fee_mode: 'distance',
      address_street: 'Av. Ipiranga',
      address_number: '1000',
      neighborhood: 'Azenha',
      city: 'Porto Alegre',
      state: 'RS',
      zip_code: '90160093',
      location: { type: 'Point', coordinates: [-51.2177, -30.0346] },
      is_active: true,
    },
    { id: 'tenant-inativo', slug: 'fechado', name: 'Fechado', is_active: false },
  ],
  categories: [
    { id: 'cat-1', tenant_id: TENANT_A, name: 'Lanches', description: null, sort_order: 1, is_active: true },
    { id: 'cat-2', tenant_id: TENANT_A, name: 'Bebidas', description: null, sort_order: 2, is_active: true },
  ],
  products: [
    {
      id: 'prod-1', tenant_id: TENANT_A, category_id: 'cat-1', name: 'X-Salada',
      description: 'Pão, carne e salada', price: '25.90', image_url: null,
      is_available: true, is_active: true, sort_order: 1,
    },
    {
      id: 'prod-2', tenant_id: TENANT_A, category_id: 'cat-2', name: 'Refrigerante',
      description: null, price: '7.00', image_url: null,
      is_available: false, is_active: true, sort_order: 1,
    },
    {
      id: 'prod-3', tenant_id: TENANT_A, category_id: null, name: 'Item avulso',
      description: null, price: '5.00', image_url: null,
      is_available: true, is_active: true, sort_order: 1,
    },
  ],
  product_option_groups: [
    {
      id: 'grp-1', tenant_id: TENANT_A, product_id: 'prod-1', name: 'Ponto da carne',
      selection_type: 'single', min_select: 1, max_select: 1, sort_order: 1, is_active: true,
    },
  ],
  product_options: [
    { id: 'opt-2', tenant_id: TENANT_A, group_id: 'grp-1', name: 'Bem passada', price_delta: '2.50', is_available: true, sort_order: 2 },
    { id: 'opt-1', tenant_id: TENANT_A, group_id: 'grp-1', name: 'Ao ponto', price_delta: '0', is_available: true, sort_order: 1 },
  ],
}

describe('getPublicMenu', () => {
  it('monta o cardápio agrupando produtos por categoria', async () => {
    const menu = await getPublicMenu(createFakeSupabase(FIXTURE), 'lancheria-t1')
    expect(menu).not.toBeNull()
    expect(menu!.tenant.name).toBe('Lancheria T1')
    expect(menu!.categories.map((c) => c.name)).toEqual(['Lanches', 'Bebidas'])
    expect(menu!.categories[0]!.products.map((p) => p.name)).toEqual(['X-Salada'])
    expect(menu!.categories[1]!.products.map((p) => p.name)).toEqual(['Refrigerante'])
  })

  it('separa produtos sem categoria', async () => {
    const menu = await getPublicMenu(createFakeSupabase(FIXTURE), 'lancheria-t1')
    expect(menu!.uncategorized.map((p) => p.name)).toEqual(['Item avulso'])
  })

  it('converte preços numéricos vindos como string do PostgREST', async () => {
    const menu = await getPublicMenu(createFakeSupabase(FIXTURE), 'lancheria-t1')
    const produto = menu!.categories[0]!.products[0]!
    expect(produto.price).toBe(25.9)
    expect(typeof produto.price).toBe('number')
  })

  it('aninha grupos de opcionais ordenados dentro do produto', async () => {
    const menu = await getPublicMenu(createFakeSupabase(FIXTURE), 'lancheria-t1')
    const grupos = menu!.categories[0]!.products[0]!.optionGroups
    expect(grupos).toHaveLength(1)
    expect(grupos[0]!.selectionType).toBe('single')
    expect(grupos[0]!.options.map((o) => o.name)).toEqual(['Ao ponto', 'Bem passada'])
    expect(grupos[0]!.options[1]!.priceDelta).toBe(2.5)
  })

  it('preserva a indisponibilidade do produto (esgotado continua no cardápio)', async () => {
    const menu = await getPublicMenu(createFakeSupabase(FIXTURE), 'lancheria-t1')
    expect(menu!.categories[1]!.products[0]!.isAvailable).toBe(false)
  })

  it('devolve null para slug inexistente', async () => {
    expect(await getPublicMenu(createFakeSupabase(FIXTURE), 'nao-existe')).toBeNull()
  })

  it('devolve null para estabelecimento inativo', async () => {
    expect(await getPublicMenu(createFakeSupabase(FIXTURE), 'fechado')).toBeNull()
  })

  it('não consulta opcionais quando não há produtos', async () => {
    const menu = await getPublicMenu(
      createFakeSupabase({ ...FIXTURE, products: [], categories: [] }),
      'lancheria-t1',
    )
    expect(menu!.categories).toEqual([])
    expect(menu!.uncategorized).toEqual([])
  })
})

describe('parseLocation', () => {
  it('extrai latitude e longitude de GeoJSON', () => {
    expect(parseLocation({ type: 'Point', coordinates: [-51.2177, -30.0346] })).toEqual({
      latitude: -30.0346,
      longitude: -51.2177,
    })
  })
  it('devolve null para valor ausente ou formato desconhecido', () => {
    expect(parseLocation(null)).toBeNull()
    expect(parseLocation('0101000020E6100000')).toBeNull()
  })
})

describe('GET /api/v1/public/menu/:slug', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = await buildTestServer()
    // Sobrepõe o cliente da requisição: este hook roda após o do plugin.
    app.addHook('onRequest', async (request) => {
      request.supabase = createFakeSupabase(FIXTURE)
    })
  })
  afterAll(async () => {
    await app.close()
  })

  it('serve o cardápio sem autenticação', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/public/menu/lancheria-t1' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.tenant.slug).toBe('lancheria-t1')
    expect(body.tenant.location).toEqual({ latitude: -30.0346, longitude: -51.2177 })
    expect(body.categories).toHaveLength(2)
  })

  it('devolve 404 para estabelecimento desconhecido', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/public/menu/nao-existe' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ statusCode: 404, error: 'Not Found' })
  })

  it('rejeita slug fora do formato permitido', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/public/menu/SLUG_INVALIDO' })
    expect(res.statusCode).toBe(400)
  })
})
