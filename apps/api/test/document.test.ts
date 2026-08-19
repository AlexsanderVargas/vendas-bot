import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  formatDocument,
  isValidCnpj,
  isValidCpf,
  normalizeDocument,
  onlyDigits,
} from '@vendas-bot/shared'
import { createFakeSupabase, type FakeWrites, type TableRows } from './fake-supabase.js'
import { bearer, buildTestServer, customerToken, CUSTOMER_A, TENANT_A } from './helpers.js'

describe('validação de CPF', () => {
  it('aceita CPF com dígitos verificadores corretos, com ou sem pontuação', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true)
    expect(isValidCpf('52998224725')).toBe(true)
  })

  it('recusa CPF com verificador errado', () => {
    expect(isValidCpf('52998224726')).toBe(false)
    expect(isValidCpf('12345678900')).toBe(false)
  })

  it('recusa sequência de dígitos repetidos', () => {
    // Formato válido, documento inexistente: é o que se digita para pular o campo.
    expect(isValidCpf('111.111.111-11')).toBe(false)
    expect(isValidCpf('00000000000')).toBe(false)
  })

  it('recusa quantidade de dígitos diferente de 11', () => {
    expect(isValidCpf('5299822472')).toBe(false)
    expect(isValidCpf('529982247250')).toBe(false)
    expect(isValidCpf('')).toBe(false)
  })
})

describe('validação de CNPJ', () => {
  it('aceita CNPJ com verificadores corretos', () => {
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true)
    expect(isValidCnpj('11222333000181')).toBe(true)
  })

  it('recusa verificador errado e dígitos repetidos', () => {
    expect(isValidCnpj('11222333000182')).toBe(false)
    expect(isValidCnpj('11111111111111')).toBe(false)
  })
})

describe('normalizeDocument', () => {
  it('devolve apenas os dígitos quando o documento é válido', () => {
    expect(normalizeDocument('529.982.247-25')).toBe('52998224725')
    expect(normalizeDocument('11.222.333/0001-81')).toBe('11222333000181')
  })

  it('devolve null quando o documento é inválido', () => {
    expect(normalizeDocument('111.111.111-11')).toBeNull()
    expect(normalizeDocument('123')).toBeNull()
    expect(normalizeDocument('')).toBeNull()
  })

  it('produz exatamente o formato que o banco aceita (11 ou 14 dígitos)', () => {
    for (const entrada of ['529.982.247-25', '11.222.333/0001-81']) {
      const normalizado = normalizeDocument(entrada)!
      expect(normalizado).toMatch(/^(\d{11}|\d{14})$/)
    }
  })
})

describe('formatDocument', () => {
  it('aplica a máscara de CPF e de CNPJ', () => {
    expect(formatDocument('52998224725')).toBe('529.982.247-25')
    expect(formatDocument('11222333000181')).toBe('11.222.333/0001-81')
  })

  it('devolve a entrada quando não reconhece o tamanho', () => {
    expect(formatDocument('123')).toBe('123')
  })

  it('onlyDigits remove qualquer pontuação', () => {
    expect(onlyDigits('529.982.247-25')).toBe('52998224725')
  })
})

describe('PUT /api/v1/me/document', () => {
  const TENANT_SLUG = 'lancheria'
  const TABLES: TableRows = {
    tenants: [{ id: TENANT_A, slug: TENANT_SLUG, is_active: true }],
    customers: [{ id: 'cus-1', tenant_id: TENANT_A, auth_user_id: CUSTOMER_A, cpf_cnpj: null }],
  }

  let app: FastifyInstance
  let writes: FakeWrites
  beforeAll(async () => {
    app = await buildTestServer()
    app.addHook('onRequest', async (request) => {
      request.supabase = createFakeSupabase(TABLES, {}, writes)
    })
  })
  beforeEach(() => {
    writes = { inserted: [], updated: [], deleted: [], signed: [], removed: [] }
  })
  afterAll(async () => {
    await app.close()
  })

  it('guarda o documento apenas com dígitos', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/me/document',
      headers: bearer(await customerToken()),
      payload: { tenantSlug: TENANT_SLUG, document: '529.982.247-25' },
    })

    expect(response.statusCode).toBe(200)
    // A pontuação digitada não pode chegar ao banco: o check aceita só dígitos.
    expect(writes.updated).toContainEqual({
      table: 'customers',
      patch: { cpf_cnpj: '52998224725' },
    })
  })

  it('recusa documento com verificador inválido antes de tocar o banco', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/me/document',
      headers: bearer(await customerToken()),
      payload: { tenantSlug: TENANT_SLUG, document: '111.111.111-11' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().message).toContain('inválido')
    // Recusado antes de qualquer escrita.
    expect(writes.updated).toHaveLength(0)
  })

  it('exige autenticação', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/me/document',
      payload: { tenantSlug: TENANT_SLUG, document: '52998224725' },
    })

    expect(response.statusCode).toBe(401)
  })
})
