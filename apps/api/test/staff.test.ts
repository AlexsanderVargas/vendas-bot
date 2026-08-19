import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createFakeSupabase, type FakeWrites, type TableRows } from './fake-supabase.js'
import { bearer, buildTestServer, customerToken, staffToken, STAFF_A, TENANT_A } from './helpers.js'

const ROLE_OWNER = 'f0000000-0000-0000-0000-0000000000aa'

const CAIXA = '00000000-0000-0000-0000-0000000000b1'

const TABLES: TableRows = {
  tenants: [{ id: TENANT_A, slug: 'lancheria-t1', name: 'Lancheria T1' }],
  users: [
    { id: STAFF_A, tenant_id: TENANT_A, is_active: true, name: 'Staff A', phone: null, role_id: ROLE_OWNER, login: null, must_change_password: false, roles: { permissions: { '*': true }, name: 'Proprietário' } },
    { id: CAIXA, tenant_id: TENANT_A, is_active: true, name: 'Caixa', phone: null, role_id: ROLE_OWNER, login: 'caixa1', must_change_password: true, roles: { permissions: {}, name: 'Caixa' } },
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

  it('impede o funcionário de trocar o próprio papel', async () => {
    // Escalada de privilégio clássica: quem administra a equipe se promoveria
    // a Proprietário sem ninguém aprovar.
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/staff/${STAFF_A}`,
      headers: bearer(await staffToken()),
      payload: { roleId: ROLE_OWNER },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toContain('próprio papel')
  })

  it('recusa papel que não pertence ao estabelecimento', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/staff/00000000-0000-0000-0000-0000000000a9',
      headers: bearer(await staffToken()),
      payload: { roleId: '11111111-1111-1111-1111-111111111111' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toContain('Papel não encontrado')
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

  it('cria acesso de funcionário com usuário e senha temporária', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/staff',
      headers: bearer(await staffToken()),
      payload: { login: 'Caixa2', name: 'Maria', roleId: ROLE_OWNER },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().login).toBe('caixa2')
    expect(res.json().temporaryPassword).toHaveLength(12)

    // O endereço técnico é derivado do usuário e do slug: é o mesmo que o
    // navegador monta na tela de entrada, sem consultar o servidor.
    const created = writes.authCreated!.at(-1)!
    expect(created.email).toBe('caixa2@lancheria-t1.equipe.gastrosync.app')
    expect(created.appMetadata).toEqual({ tenant_id: TENANT_A })

    const linked = writes.inserted.at(-1)!
    expect(linked.table).toBe('users')
    expect(linked.rows[0]).toMatchObject({ login: 'caixa2', must_change_password: true })
  })

  it('recusa nome de usuário fora do formato', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/staff',
      headers: bearer(await staffToken()),
      payload: { login: 'Caixa 2', name: 'Maria', roleId: ROLE_OWNER },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toContain('Usuário deve começar com letra')
  })

  it('recusa usuário já existente no estabelecimento', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/staff',
      headers: bearer(await staffToken()),
      payload: { login: 'caixa1', name: 'Outro', roleId: ROLE_OWNER },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toContain('já existe')
  })

  it('gera nova senha temporária e reobriga a troca', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/staff/${CAIXA}/senha`,
      headers: bearer(await staffToken()),
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().temporaryPassword).toHaveLength(12)
    expect(writes.authUpdated!.at(-1)).toMatchObject({ id: CAIXA })
    expect(writes.updated.at(-1)).toMatchObject({
      table: 'users',
      patch: { must_change_password: true },
    })
  })

  it('não gera senha para funcionário de outro estabelecimento', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/staff/00000000-0000-0000-0000-0000000000a9/senha',
      headers: bearer(await staffToken()),
    })
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

  it('convida por e-mail apontando para o painel do estabelecimento', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/staff/invite',
      headers: bearer(await staffToken()),
      payload: { email: 'gerente@exemplo.com', name: 'Gerente', roleId: ROLE_OWNER },
    })

    expect(res.statusCode).toBe(201)
    // Sem redirectTo o convite cairia na raiz do Site URL, que não sabe de
    // qual estabelecimento é o funcionário.
    expect(writes.authInvited!.at(-1)!.redirectTo).toBe(
      'http://localhost:3000/lancheria-t1/painel/definir-senha',
    )
  })
})
