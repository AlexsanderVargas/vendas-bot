import { Type } from '@sinclair/typebox'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { normalizeDocument, Slug, StandardErrors, Uuid } from '@vendas-bot/shared'

/** Contrato de saída: identidade do usuário autenticado e seu vínculo. */
const MeResponse = Type.Object({
  userId: Uuid,
  email: Type.Union([Type.String(), Type.Null()]),
  tenantId: Type.Union([Uuid, Type.Null()]),
  isStaff: Type.Boolean(),
})

const DocumentBody = Type.Object({
  tenantSlug: Slug,
  /** CPF ou CNPJ, com ou sem pontuação. Null limpa o que estava guardado. */
  document: Type.Union([Type.String({ maxLength: 20 }), Type.Null()]),
})

/** Contrato de saída: o documento guardado, só com dígitos. */
const DocumentResponse = Type.Object({
  document: Type.Union([Type.String(), Type.Null()]),
})

const PasswordBody = Type.Object({
  password: Type.String({ minLength: 8, maxLength: 72 }),
})

const PasswordResponse = Type.Object({
  /** Sempre false depois da troca: a senha deixou de ser a temporária. */
  mustChangePassword: Type.Boolean(),
})

const meRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/me',
    {
      onRequest: app.requireAuth,
      schema: {
        tags: ['auth'],
        description: 'Identidade derivada do JWT do Supabase Auth.',
        security: [{ bearerAuth: [] }],
        response: { 200: MeResponse, ...StandardErrors },
      },
    },
    async (request) => {
      const auth = request.auth!
      return {
        userId: auth.userId,
        email: auth.email,
        tenantId: auth.tenantId,
        isStaff: auth.tenantId !== null,
      }
    },
  )

  app.put(
    '/me/document',
    {
      onRequest: app.requireAuth,
      schema: {
        tags: ['auth'],
        description:
          'Guarda o CPF/CNPJ do cliente no estabelecimento. Opcional: usado na nota fiscal e por gateways que exigem documento (Asaas).',
        security: [{ bearerAuth: [] }],
        body: DocumentBody,
        response: { 200: DocumentResponse, ...StandardErrors },
      },
    },
    async (request) => {
      const { document, tenantSlug } = request.body

      // Valida os dígitos verificadores, não só o formato: o banco aceita
      // qualquer sequência de 11 ou 14 dígitos, e um CPF inventado só seria
      // recusado lá na frente, pelo gateway ou pela SEFAZ.
      const normalized = document === null ? null : normalizeDocument(document)
      if (document !== null && normalized === null) {
        throw app.httpErrors.badRequest('CPF ou CNPJ inválido')
      }

      const { data: tenant } = await request.supabase
        .from('tenants')
        .select('id')
        .eq('slug', tenantSlug)
        .eq('is_active', true)
        .maybeSingle()

      if (!tenant) throw app.httpErrors.notFound('Estabelecimento não encontrado')

      // A RLS restringe o update ao próprio cadastro (customers_self_update).
      const { data, error } = await request.supabase
        .from('customers')
        .update({ cpf_cnpj: normalized })
        .eq('tenant_id', tenant.id)
        .eq('auth_user_id', request.auth!.userId)
        .select('cpf_cnpj')
        .maybeSingle()

      if (error) throw app.httpErrors.internalServerError(error.message)
      if (!data) throw app.httpErrors.notFound('Cadastro de cliente não encontrado')

      return { document: (data.cpf_cnpj as string | null) ?? null }
    },
  )

  app.put(
    '/me/senha',
    {
      onRequest: app.requireStaff,
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        tags: ['auth'],
        description:
          'Troca a senha do próprio acesso de funcionário e encerra a obrigação de troca. Cliente não usa senha: entra por SSO.',
        security: [{ bearerAuth: [] }],
        body: PasswordBody,
        response: { 200: PasswordResponse, ...StandardErrors },
      },
    },
    async (request) => {
      const userId = request.auth!.userId
      const tenantId = request.requireTenantId()

      // A troca corre pelo Admin API porque `must_change_password` não está
      // nos grants de `authenticated` (migration 38): quem levanta a bandeira
      // é quem administra, quem a baixa é o servidor, depois de trocar mesmo
      // a senha. Fosse a bandeira editável pelo próprio usuário, bastaria
      // limpá-la para seguir usando a senha temporária.
      const { error: passwordError } = await app.supabaseAdmin.auth.admin.updateUserById(userId, {
        password: request.body.password,
      })
      if (passwordError) throw app.httpErrors.badRequest(passwordError.message)

      const { error: flagError } = await app.supabaseAdmin
        .from('users')
        .update({ must_change_password: false })
        .eq('id', userId)
        .eq('tenant_id', tenantId)
      if (flagError) throw app.httpErrors.internalServerError(flagError.message)

      return { mustChangePassword: false }
    },
  )
}

export default meRoutes
