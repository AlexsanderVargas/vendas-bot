import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { toIngredient, toSupplier } from '../src/modules/inventory/service.js'
import { createFakeSupabase, type TableRows } from './fake-supabase.js'
import { bearer, buildTestServer, customerToken, staffToken, STAFF_A, TENANT_A } from './helpers.js'

const TABLES: TableRows = {
  users: [{ id: STAFF_A, tenant_id: TENANT_A, is_active: true, roles: { permissions: { '*': true } } }],
  ingredients: [
    { id: 'b0000000-0000-0000-0000-000000000001', name: 'Carne bovina', sku: null, base_unit: 'g', average_cost: '0.0450', stock_quantity: '1500.000', minimum_stock: '2000.000', is_perishable: true, shelf_life_days: 5, is_active: true },
    { id: 'b0000000-0000-0000-0000-000000000002', name: 'Pão de hambúrguer', sku: 'PAO-01', base_unit: 'un', average_cost: '1.2000', stock_quantity: '80.000', minimum_stock: '20.000', is_perishable: false, shelf_life_days: null, is_active: true },
  ],
  suppliers: [
    { id: 'a0000000-0000-0000-0000-000000000001', name: 'Distribuidora Sul', document: '12345678000199', email: null, phone: null, contact_name: 'Ana', notes: null, is_active: true },
  ],
}

describe('toIngredient', () => {
  it('normaliza numéricos e deriva belowMinimum', () => {
    const ingredient = toIngredient(TABLES.ingredients![0] as never)
    expect(ingredient.stockQuantity).toBe(1500)
    expect(ingredient.minimumStock).toBe(2000)
    expect(ingredient.averageCost).toBe(0.045)
    expect(ingredient.belowMinimum).toBe(true)
  })
  it('não marca reposição quando o estoque está acima do mínimo', () => {
    expect(toIngredient(TABLES.ingredients![1] as never).belowMinimum).toBe(false)
  })
  it('trata estoque exatamente no mínimo como abaixo (gatilho de reposição)', () => {
    const base = TABLES.ingredients![1] as Record<string, unknown>
    const ingredient = toIngredient({ ...base, stock_quantity: '20.000' } as never)
    expect(ingredient.belowMinimum).toBe(true)
  })
})

describe('toSupplier', () => {
  it('normaliza contact_name para contactName', () => {
    expect(toSupplier(TABLES.suppliers![0] as never).contactName).toBe('Ana')
  })
})

describe('rotas de estoque', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = await buildTestServer()
    app.addHook('onRequest', async (request) => {
      const fake = createFakeSupabase(TABLES)
      request.supabase = fake
      Object.defineProperty(app, 'supabaseAdmin', { value: fake, configurable: true })
    })
  })
  afterAll(async () => {
    await app.close()
  })

  it('exige autenticação', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/ingredients' })
    expect(res.statusCode).toBe(401)
  })

  it('recusa cliente B2C (sem vínculo de funcionário)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/ingredients',
      headers: bearer(await customerToken()),
    })
    expect(res.statusCode).toBe(403)
  })

  it('lista insumos para funcionário autorizado', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/ingredients',
      headers: bearer(await staffToken()),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(2)
  })

  it('filtra apenas os insumos abaixo do mínimo', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/ingredients?belowMinimum=true',
      headers: bearer(await staffToken()),
    })
    expect(res.json()).toHaveLength(1)
    expect(res.json()[0].name).toBe('Carne bovina')
  })

  it('busca insumo por nome, sem diferenciar caixa', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/ingredients?search=carne',
      headers: bearer(await staffToken()),
    })
    expect(res.json()).toHaveLength(1)
  })

  it('recusa insumo perecível sem prazo de validade', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ingredients',
      headers: bearer(await staffToken()),
      payload: { name: 'Alface', baseUnit: 'g', isPerishable: true },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toContain('prazo de validade')
  })

  it('rejeita unidade de medida desconhecida', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ingredients',
      headers: bearer(await staffToken()),
      payload: { name: 'Azeite', baseUnit: 'litro' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejeita documento de fornecedor fora do formato', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/suppliers',
      headers: bearer(await staffToken()),
      payload: { name: 'Fornecedor X', document: '123' },
    })
    expect(res.statusCode).toBe(400)
  })
})
