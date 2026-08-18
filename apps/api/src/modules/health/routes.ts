import { Type } from '@sinclair/typebox'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'

/** Contrato de saída: { status, uptime, timestamp }. */
const HealthResponse = Type.Object({
  status: Type.Literal('ok'),
  uptime: Type.Number(),
  timestamp: Type.String({ format: 'date-time' }),
})

const healthRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/health',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['infra'],
        description: 'Liveness probe.',
        response: { 200: HealthResponse },
      },
    },
    async () => ({
      status: 'ok' as const,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    }),
  )
}

export default healthRoutes
