import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createFakeSupabase, type TableRows } from './fake-supabase.js'
import { bearer, buildTestServer, customerToken, staffToken, STAFF_A, TENANT_A } from './helpers.js'

const ROLE_OWNER = 'f0000000-0000-0000-0000-0000000000aa'

const TABLES: TableRows = {
  users: [
    { id: STAFF_A, tenant_id: TENANT_A, is_active: true, name: 'Staff A', phone: null, role_id: ROLE_OWNER, roles: { permissions: { '*': true }, name: 'Proprietário' } },
  ],
  roles: [
    { id: ROLE_OWNER, tenant_id: null, key: 'owner', name: 'Proprietário', permissions: { '*': true } },
  ],
  permission_catalog: [
    { key: 'orders.read', module: 'Pedidos', label: 'Ver pedidos', description: null, sort_order: 10 },
    { key: 'staff.write', module: 'Equipe', label: 'Gerenciar funcionários', description: null, sort_order: 81 },
  ],
}

describe('rotas de equipe e papéis', () => {
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

  it('exige autenticação para o catálogo de permissões', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/permissions' })
    expect(res.statusCode).toBe(401)
  })

  it('recusa cliente B2C na área de equipe', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/staff',
      headers: bearer(await customerToken()),
    })
    expect(res.statusCode).toBe(403)
  })

  it('lista o catálogo de permissões para quem pode ler equipe', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/permissions',
      headers: bearer(await staffToken()),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(2)
    expect(res.json()[0]).toMatchObject({ key: 'orders.read', module: 'Pedidos' })
  })

  it('marca papéis sem tenant como de sistema', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/roles',
      headers: bearer(await staffToken()),
    })
    expect(res.json()[0]).toMatchObject({ key: 'owner', isSystem: true })
  })

  it('rejeita chave de papel fora do formato', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/roles',
      headers: bearer(await staffToken()),
      payload: { key: 'Garçom Júnior', name: 'Garçom júnior', permissions: { 'orders.read': true } },
    })
    expect(res.statusCode).toBe(400)
  })

  it('impede o funcionário de desativar a própria conta', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/staff/${STAFF_A}`,
      headers: bearer(await staffToken()),
      payload: { isActive: false },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toContain('própria conta')
  })

  it('permite desativar outro funcionário', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/staff/00000000-0000-0000-0000-0000000000a9',
      headers: bearer(await staffToken()),
      payload: { isActive: false },
    })
    // O funcionário não existe no fixture: o importante é não ter sido barrado
    // pela regra de autoproteção.
    expect(res.statusCode).toBe(404)
  })

  it('valida o e-mail no convite', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/staff/invite',
      headers: bearer(await staffToken()),
      payload: { email: 'sem-arroba', name: 'Novo', roleId: ROLE_OWNER },
    })
    expect(res.statusCode).toBe(400)
  })

  it('exige papel existente no convite', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/staff/invite',
      headers: bearer(await staffToken()),
      payload: {
        email: 'novo@exemplo.com',
        name: 'Novo',
        roleId: '11111111-1111-1111-1111-111111111111',
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toContain('Papel não encontrado')
  })
})
