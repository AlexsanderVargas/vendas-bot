import { Type } from '@sinclair/typebox'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { StandardErrors, Uuid } from '@vendas-bot/shared'

/** Contrato de saída: identidade do usuário autenticado e seu vínculo. */
const MeResponse = Type.Object({
  userId: Uuid,
  email: Type.Union([Type.String(), Type.Null()]),
  tenantId: Type.Union([Uuid, Type.Null()]),
  isStaff: Type.Boolean(),
})

const meRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/me',
    {
      preHandler: app.requireAuth,
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
}

export default meRoutes
