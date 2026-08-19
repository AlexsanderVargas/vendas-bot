import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { hasPermission } from '../src/plugins/auth.js'
import { createFakeSupabase, type FakeWrites, type TableRows } from './fake-supabase.js'
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

describe('PUT /api/v1/me/senha', () => {
  const TABLES: TableRows = {
    users: [
      {
        id: STAFF_A,
        tenant_id: TENANT_A,
        is_active: true,
        name: 'Staff A',
        role_id: 'f0000000-0000-0000-0000-0000000000aa',
        must_change_password: true,
        roles: { permissions: { '*': true } },
      },
    ],
  }

  let app: FastifyInstance
  const writes: FakeWrites = { inserted: [], updated: [], deleted: [], signed: [], removed: [] }

  beforeAll(async () => {
    app = await buildTestServer()
    app.addHook('onRequest', async (request) => {
      const fake = createFakeSupabase(TABLES, {}, writes)
      request.supabase = fake
      Object.defineProperty(app, 'supabaseAdmin', { value: fake, configurable: true })
    })
  })
  afterAll(async () => {
    await app.close()
  })

  it('recusa cliente B2C: quem entra por SSO não tem senha', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/me/senha',
      headers: bearer(await customerToken()),
      payload: { password: 'senha-bem-longa' },
    })
    expect(response.statusCode).toBe(403)
  })

  it('recusa senha curta', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/me/senha',
      headers: bearer(await staffToken()),
      payload: { password: 'curta' },
    })
    expect(response.statusCode).toBe(400)
  })

  it('troca a senha e encerra a obrigação de troca', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/me/senha',
      headers: bearer(await staffToken()),
      payload: { password: 'uma-senha-de-verdade' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ mustChangePassword: false })
    expect(writes.authUpdated!.at(-1)).toMatchObject({
      id: STAFF_A,
      password: 'uma-senha-de-verdade',
    })
    // A bandeira só baixa junto com a troca de fato: fosse editável pelo
    // próprio usuário, bastaria limpá-la para seguir na senha temporária.
    expect(writes.updated.at(-1)).toMatchObject({
      table: 'users',
      patch: { must_change_password: false },
    })
  })
})
