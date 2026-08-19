import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import { StandardErrors, Uuid } from '@vendas-bot/shared'

const Permission = Type.Object({
  key: Type.String(),
  module: Type.String(),
  label: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
})

/** Contrato de saída de um papel (perfil de acesso). */
const Role = Type.Object({
  id: Uuid,
  key: Type.String(),
  name: Type.String(),
  permissions: Type.Record(Type.String(), Type.Boolean()),
  isSystem: Type.Boolean(),
})

const RoleInput = Type.Object({
  key: Type.String({ pattern: '^[a-z][a-z0-9_]{1,38}$' }),
  name: Type.String({ minLength: 1, maxLength: 80 }),
  permissions: Type.Record(Type.String(), Type.Boolean()),
})

/** Contrato de saída de um funcionário. */
const StaffMember = Type.Object({
  id: Uuid,
  name: Type.String(),
  phone: Type.Union([Type.String(), Type.Null()]),
  isActive: Type.Boolean(),
  roleId: Uuid,
  roleName: Type.Union([Type.String(), Type.Null()]),
})

const InviteInput = Type.Object({
  email: Type.String({ format: 'email', maxLength: 160 }),
  name: Type.String({ minLength: 1, maxLength: 120 }),
  roleId: Uuid,
  phone: Type.Optional(Type.Union([Type.String({ maxLength: 20 }), Type.Null()])),
})

const StaffUpdate = Type.Object({
  roleId: Type.Optional(Uuid),
  isActive: Type.Optional(Type.Boolean()),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  phone: Type.Optional(Type.Union([Type.String({ maxLength: 20 }), Type.Null()])),
})

const IdParams = Type.Object({ id: Uuid })

const staffRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/permissions',
    {
      onRequest: app.requirePermission('staff.read'),
      schema: {
        tags: ['equipe'],
        description: 'Catálogo de permissões reconhecidas pelo sistema.',
        response: { 200: Type.Array(Permission), ...StandardErrors },
      },
    },
    async (request) => {
      const { data, error } = await request.supabase
        .from('permission_catalog')
        .select('key, module, label, description')
        .order('sort_order', { ascending: true })

      if (error) throw app.httpErrors.internalServerError(error.message)
      return (data ?? []).map((row: Record<string, unknown>) => ({
        key: String(row.key),
        module: String(row.module),
        label: String(row.label),
        description: (row.description as string | null) ?? null,
      }))
    },
  )

  app.get(
    '/roles',
    {
      onRequest: app.requirePermission('staff.read'),
      schema: {
        tags: ['equipe'],
        description: 'Papéis de sistema e os customizados do estabelecimento.',
        response: { 200: Type.Array(Role), ...StandardErrors },
      },
    },
    async (request) => {
      const { data, error } = await request.supabase
        .from('roles')
        .select('id, tenant_id, key, name, permissions')
        .order('key', { ascending: true })

      if (error) throw app.httpErrors.internalServerError(error.message)
      return (data ?? []).map((row: Record<string, unknown>) => ({
        id: String(row.id),
        key: String(row.key),
        name: String(row.name),
        permissions: (row.permissions ?? {}) as Record<string, boolean>,
        isSystem: row.tenant_id === null,
      }))
    },
  )

  app.post(
    '/roles',
    {
      onRequest: app.requirePermission('staff.write'),
      schema: {
        tags: ['equipe'],
        description: 'Cria um papel customizado. Permissões fora do catálogo são recusadas.',
        body: RoleInput,
        response: { 201: Type.Object({ id: Uuid }), ...StandardErrors },
      },
    },
    async (request, reply) => {
      const tenantId = request.requireTenantId()
      // `authenticated` não escreve mais em roles (migration 38): a permissão
      // já foi conferida no onRequest, e o tenant_id vem do claim, nunca do
      // corpo da requisição.
      const { data, error } = await app.supabaseAdmin
        .from('roles')
        .insert({
          tenant_id: tenantId,
          key: request.body.key,
          name: request.body.name,
          permissions: request.body.permissions,
        })
        .select('id')
        .single()

      if (error) {
        throw app.httpErrors.badRequest(
          error.message.includes('permissão desconhecida')
            ? `Papel contém permissão que o sistema não reconhece: ${error.message}`
            : error.message,
        )
      }
      return reply.status(201).send({ id: data.id })
    },
  )

  app.get(
    '/staff',
    {
      onRequest: app.requirePermission('staff.read'),
      schema: {
        tags: ['equipe'],
        description: 'Funcionários do estabelecimento.',
        response: { 200: Type.Array(StaffMember), ...StandardErrors },
      },
    },
    async (request) => {
      const { data, error } = await request.supabase
        .from('users')
        .select('id, name, phone, is_active, role_id, roles(name)')
        .order('name', { ascending: true })

      if (error) throw app.httpErrors.internalServerError(error.message)
      return (data ?? []).map((row: Record<string, unknown>) => {
        const role = (row.roles ?? null) as { name?: string } | null
        return {
          id: String(row.id),
          name: String(row.name),
          phone: (row.phone as string | null) ?? null,
          isActive: Boolean(row.is_active),
          roleId: String(row.role_id),
          roleName: role?.name ?? null,
        }
      })
    },
  )

  app.post(
    '/staff/invite',
    {
      onRequest: app.requirePermission('staff.write'),
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['equipe'],
        description:
          'Convida um funcionário por e-mail e grava o vínculo com o estabelecimento no claim do JWT.',
        body: InviteInput,
        response: { 201: Type.Object({ userId: Uuid }), ...StandardErrors },
      },
    },
    async (request, reply) => {
      const tenantId = request.requireTenantId()

      // O papel precisa ser de sistema ou do próprio tenant — senão um gestor
      // poderia atribuir um papel alheio ao funcionário.
      const { data: role } = await request.supabase
        .from('roles')
        .select('id')
        .eq('id', request.body.roleId)
        .maybeSingle()
      if (!role) throw app.httpErrors.badRequest('Papel não encontrado')

      // O convite e a escrita do claim exigem service_role: o próprio usuário
      // não pode se atribuir a um estabelecimento.
      const { data: invited, error: inviteError } =
        await app.supabaseAdmin.auth.admin.inviteUserByEmail(request.body.email, {
          data: { full_name: request.body.name },
        })

      if (inviteError || !invited?.user) {
        throw app.httpErrors.badRequest(inviteError?.message ?? 'Não foi possível convidar o funcionário')
      }

      const { error: claimError } = await app.supabaseAdmin.auth.admin.updateUserById(
        invited.user.id,
        { app_metadata: { tenant_id: tenantId } },
      )
      if (claimError) throw app.httpErrors.internalServerError(claimError.message)

      const { error: userError } = await app.supabaseAdmin.from('users').insert({
        id: invited.user.id,
        tenant_id: tenantId,
        role_id: request.body.roleId,
        name: request.body.name,
        phone: request.body.phone ?? null,
      })
      if (userError) throw app.httpErrors.badRequest(userError.message)

      return reply.status(201).send({ userId: invited.user.id })
    },
  )

  app.patch(
    '/staff/:id',
    {
      onRequest: app.requirePermission('staff.write'),
      schema: {
        tags: ['equipe'],
        description: 'Atualiza papel, dados ou situação de um funcionário.',
        params: IdParams,
        body: StaffUpdate,
        response: { 200: StaffMember, ...StandardErrors },
      },
    },
    async (request) => {
      const tenantId = request.requireTenantId()

      // Um gestor desativar a si mesmo deixaria o estabelecimento sem acesso
      // no meio do expediente.
      if (request.body.isActive === false && request.params.id === request.auth!.userId) {
        throw app.httpErrors.badRequest('Você não pode desativar a própria conta')
      }

      // Trocar o próprio papel é a escalada clássica: quem tem staff.write se
      // promoveria a Proprietário sem ninguém aprovar. O banco também barra
      // (trigger users_enforce_privileges), mas a mensagem aqui é útil.
      if (request.body.roleId !== undefined && request.params.id === request.auth!.userId) {
        throw app.httpErrors.badRequest('Você não pode alterar o próprio papel')
      }

      // Papel de outro estabelecimento traria permissões de fora para dentro.
      if (request.body.roleId !== undefined) {
        const { data: role } = await request.supabase
          .from('roles')
          .select('id')
          .eq('id', request.body.roleId)
          .maybeSingle()
        if (!role) throw app.httpErrors.badRequest('Papel não encontrado')
      }

      const patch: Record<string, unknown> = {}
      if (request.body.roleId !== undefined) patch.role_id = request.body.roleId
      if (request.body.isActive !== undefined) patch.is_active = request.body.isActive
      if (request.body.name !== undefined) patch.name = request.body.name
      if (request.body.phone !== undefined) patch.phone = request.body.phone

      // supabaseAdmin ignora RLS: o recorte por estabelecimento passa a ser
      // responsabilidade deste filtro, e não pode faltar.
      const { data, error } = await app.supabaseAdmin
        .from('users')
        .update(patch)
        .eq('id', request.params.id)
        .eq('tenant_id', tenantId)
        .select('id, name, phone, is_active, role_id, roles(name)')
        .maybeSingle()

      if (error) throw app.httpErrors.badRequest(error.message)
      if (!data) throw app.httpErrors.notFound('Funcionário não encontrado')

      const role = (data.roles ?? null) as { name?: string } | null
      return {
        id: data.id,
        name: data.name,
        phone: data.phone,
        isActive: data.is_active,
        roleId: data.role_id,
        roleName: role?.name ?? null,
      }
    },
  )
}

export default staffRoutes
