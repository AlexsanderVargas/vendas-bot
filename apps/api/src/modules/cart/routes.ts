import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import { ErrorResponse, StandardErrors } from '@vendas-bot/shared'
import { resolveCustomerContext } from '../../lib/customer.js'
import { Cart, CartQuery, CartSyncInput, Suggestion, SuggestionInput } from './schemas.js'
import { ensureCart, replaceCartItems, toCartItems } from './service.js'

const CART_ITEM_COLUMNS = 'line_key, product_id, quantity, notes, selected_options'

const cartRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/cart',
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ['carrinho'],
        description: 'Carrinho persistido do cliente no estabelecimento.',
        querystring: CartQuery,
        response: { 200: Cart, ...StandardErrors },
      },
    },
    async (request) => {
      const context = await resolveCustomerContext(
        request.supabase,
        request.query.tenantSlug,
        request.auth!.userId,
      )
      if (!context) {
        return { id: null, tenantSlug: request.query.tenantSlug, items: [], updatedAt: null }
      }

      const { data: cart } = await request.supabase
        .from('carts')
        .select('id, updated_at')
        .eq('tenant_id', context.tenantId)
        .eq('customer_id', context.customerId)
        .maybeSingle()

      if (!cart) {
        return { id: null, tenantSlug: request.query.tenantSlug, items: [], updatedAt: null }
      }

      const { data: items } = await request.supabase
        .from('cart_items')
        .select(CART_ITEM_COLUMNS)
        .eq('cart_id', cart.id)

      return {
        id: cart.id,
        tenantSlug: request.query.tenantSlug,
        items: toCartItems(items ?? []),
        updatedAt: cart.updated_at,
      }
    },
  )

  app.put(
    '/cart',
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ['carrinho'],
        description: 'Sincroniza o carrinho local com o banco (reengajamento).',
        body: CartSyncInput,
        response: { 200: Cart, ...StandardErrors },
      },
    },
    async (request) => {
      const context = await resolveCustomerContext(
        request.supabase,
        request.body.tenantSlug,
        request.auth!.userId,
      )
      if (!context) {
        throw app.httpErrors.forbidden('Complete o cadastro no estabelecimento antes de sincronizar o carrinho')
      }

      // Linhas repetidas indicariam bug no cliente: rejeitar cedo evita
      // gravar um carrinho ambíguo.
      const keys = new Set(request.body.items.map((item) => item.lineKey))
      if (keys.size !== request.body.items.length) {
        throw app.httpErrors.badRequest('Carrinho contém linhas duplicadas')
      }

      const cartId = await ensureCart(request.supabase, context.tenantId, context.customerId)
      await replaceCartItems(request.supabase, cartId, request.body.items)

      return {
        id: cartId,
        tenantSlug: request.body.tenantSlug,
        items: request.body.items,
        updatedAt: new Date().toISOString(),
      }
    },
  )

  app.post(
    '/public/suggestions',
    {
      schema: {
        tags: ['carrinho'],
        description: 'Sugestões de upsell/cross-sell para o carrinho atual.',
        body: SuggestionInput,
        response: { 200: Type.Array(Suggestion), 404: ErrorResponse, 429: ErrorResponse },
      },
    },
    async (request) => {
      const { data: tenant } = await request.supabase
        .from('tenants')
        .select('id')
        .eq('slug', request.body.tenantSlug)
        .eq('is_active', true)
        .maybeSingle()

      if (!tenant) throw app.httpErrors.notFound('Estabelecimento não encontrado')

      const { data, error } = await request.supabase.rpc('suggest_upsell', {
        p_tenant_id: tenant.id,
        p_category_ids: request.body.categoryIds,
        p_exclude_product_ids: request.body.excludeProductIds,
        p_limit: request.body.limit,
      })

      if (error) throw app.httpErrors.internalServerError(error.message)

      return (data ?? []).map((row: Record<string, unknown>) => ({
        id: String(row.id),
        name: String(row.name),
        description: (row.description as string | null) ?? null,
        price: Number(row.price),
        imageUrl: (row.image_url as string | null) ?? null,
      }))
    },
  )
}

export default cartRoutes
