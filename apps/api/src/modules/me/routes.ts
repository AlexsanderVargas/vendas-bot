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
}

export default meRoutes
