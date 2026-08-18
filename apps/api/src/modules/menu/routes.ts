import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { ErrorResponse } from '@vendas-bot/shared'
import { MenuParams, MenuResponse } from './schemas.js'
import { getPublicMenu } from './service.js'

/**
 * Cardápio público: sem autenticação, servido pelo cliente anônimo do
 * Supabase — as políticas de leitura pública do PBI 1 e da migration
 * 20260818000008 garantem que só tenants e produtos ativos apareçam.
 */
const menuRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/public/menu/:slug',
    {
      schema: {
        tags: ['cardápio'],
        description: 'Cardápio completo de um estabelecimento, por slug.',
        params: MenuParams,
        response: { 200: MenuResponse, 404: ErrorResponse, 429: ErrorResponse },
      },
    },
    async (request) => {
      const menu = await getPublicMenu(request.supabase, request.params.slug)
      if (!menu) throw app.httpErrors.notFound('Estabelecimento não encontrado')
      return menu
    },
  )
}

export default menuRoutes
