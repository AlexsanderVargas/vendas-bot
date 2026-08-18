import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { hasPermission } from '../src/plugins/auth.js'
import { bearer, buildTestServer, customerToken, signToken, staffToken, STAFF_A, TENANT_A } from './helpers.js'

describe('resolução de permissões RBAC', () => {
  it('concede por permissão exata', () => {
    expect(hasPermission({ 'orders.create': true }, 'orders.create')).toBe(true)
  })
  it('concede por curinga de domínio', () => {
    expect(hasPermission({ 'orders.*': true }, 'orders.create')).toBe(true)
  })
  it('concede por curinga global', () => {
    expect(hasPermission({ '*': true }, 'cash.close')).toBe(true)
  })
  it('nega quando ausente', () => {
    expect(hasPermission({ 'products.*': true }, 'cash.close')).toBe(false)
  })
  it('negação explícita vence curinga', () => {
    expect(hasPermission({ '*': true, 'cash.close': false }, 'cash.close')).toBe(false)
    expect(hasPermission({ 'orders.*': true, 'orders.delete': false }, 'orders.delete')).toBe(false)
  })
  it('curinga mais específico tem precedência sobre o global', () => {
    expect(hasPermission({ '*': true, 'cash.*': false }, 'cash.close')).toBe(false)
  })
  it('resolve permissões de três níveis', () => {
    expect(hasPermission({ 'reports.finance.*': true }, 'reports.finance.dre')).toBe(true)
    expect(hasPermission({ 'reports.*': true }, 'reports.finance.dre')).toBe(true)
  })
})

describe('GET /api/v1/me', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = await buildTestServer()
  })
  afterAll(async () => {
    await app.close()
  })

  it('exige autenticação', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/me' })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ statusCode: 401, error: 'Unauthorized' })
  })

  it('rejeita token com assinatura inválida', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: bearer('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.assinatura-invalida'),
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejeita token expirado', async () => {
    const { SignJWT } = await import('jose')
    const expired = await new SignJWT({ app_metadata: {} })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(STAFF_A)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET!))

    const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(expired) })
    expect(res.statusCode).toBe(401)
  })

  it('identifica funcionário com tenant_id no claim', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: bearer(await staffToken()),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      userId: STAFF_A,
      email: null,
      tenantId: TENANT_A,
      isStaff: true,
    })
  })

  it('identifica cliente B2C sem tenant_id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: bearer(await customerToken()),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().isStaff).toBe(false)
    expect(res.json().tenantId).toBeNull()
  })

  it('propaga o e-mail quando presente no token', async () => {
    const token = await signToken(STAFF_A, { tenant_id: TENANT_A }, { email: 'staff@t1.com' })
    const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(token) })
    expect(res.json().email).toBe('staff@t1.com')
  })

  it('ignora cabeçalho Authorization sem esquema Bearer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: await staffToken() },
    })
    expect(res.statusCode).toBe(401)
  })
})
