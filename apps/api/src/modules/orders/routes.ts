import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import { StandardErrors } from '@vendas-bot/shared'
import { resolveCustomerContext } from '../../lib/customer.js'
import {
  AdvanceStatusInput,
  AdvanceStatusResult,
  CheckoutInput,
  CheckoutResult,
  Order,
  OrderListQuery,
  OrderParams,
  OrderStatusEvent,
} from './schemas.js'
import {
  listOrders,
  mapAdvanceError,
  mapCheckoutError,
  ORDER_COLUMNS,
  ORDER_ITEM_COLUMNS,
  toOrder,
} from './service.js'

import type { OrderChannel, OrderStatus } from '@vendas-bot/shared'

interface CheckoutRpcOrder {
  id: string
  orderNumber: number | string
  status: OrderStatus
  channel: OrderChannel
  subtotal: number | string
  deliveryFee: number | string
  total: number | string
  etaMinutes: number | null
}

interface CheckoutRpcResult {
  ok: boolean
  error: string | null
  order: CheckoutRpcOrder | null
}

const orderRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/orders/checkout',
    {
      onRequest: app.requireAuth,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['pedidos'],
        description:
          'Converte o carrinho em pedido. Preço, disponibilidade e taxa de entrega são recalculados no servidor.',
        body: CheckoutInput,
        response: { 201: CheckoutResult, 409: StandardErrors[400], ...StandardErrors },
      },
    },
    async (request, reply) => {
      const context = await resolveCustomerContext(
        request.supabase,
        request.body.tenantSlug,
        request.auth!.userId,
      )
      if (!context) {
        throw app.httpErrors.forbidden('Complete seu cadastro no estabelecimento antes de pedir')
      }

      const { data, error } = await request.supabase.rpc('checkout_order', {
        p_tenant_id: context.tenantId,
        p_customer_id: context.customerId,
        p_channel: request.body.channel,
        p_items: request.body.items.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
          notes: item.notes ?? null,
          optionIds: item.optionIds,
        })),
        p_address_id: request.body.addressId ?? null,
        p_notes: request.body.notes ?? null,
      })

      if (error) throw app.httpErrors.internalServerError(error.message)

      const result = data as CheckoutRpcResult
      if (!result.ok || !result.order) {
        const mapped = mapCheckoutError(result.error ?? 'desconhecido')
        throw app.httpErrors.createError(mapped.status, mapped.message)
      }

      const order = result.order
      return reply.status(201).send({
        id: String(order.id),
        orderNumber: Number(order.orderNumber),
        status: order.status,
        channel: order.channel,
        subtotal: Number(order.subtotal),
        deliveryFee: Number(order.deliveryFee),
        total: Number(order.total),
        etaMinutes: order.etaMinutes === null ? null : Number(order.etaMinutes),
      })
    },
  )

  app.get(
    '/orders',
    {
      onRequest: app.requireAuth,
      schema: {
        tags: ['pedidos'],
        description: 'Histórico de pedidos do cliente autenticado.',
        querystring: OrderListQuery,
        response: { 200: Type.Array(Order), ...StandardErrors },
      },
    },
    async (request) => {
      let tenantId: string | null = null
      if (request.query.tenantSlug) {
        const { data: tenant } = await request.supabase
          .from('tenants')
          .select('id')
          .eq('slug', request.query.tenantSlug)
          .maybeSingle()
        if (!tenant) return []
        tenantId = tenant.id
      }

      return listOrders(request.supabase, {
        tenantId,
        limit: request.query.limit,
        offset: request.query.offset,
      })
    },
  )

  app.get(
    '/orders/:id',
    {
      onRequest: app.requireAuth,
      schema: {
        tags: ['pedidos'],
        description: 'Detalhe de um pedido (a RLS garante que seja do próprio cliente).',
        params: OrderParams,
        response: { 200: Order, ...StandardErrors },
      },
    },
    async (request) => {
      const { data: order } = await request.supabase
        .from('orders')
        .select(ORDER_COLUMNS)
        .eq('id', request.params.id)
        .maybeSingle()

      if (!order) throw app.httpErrors.notFound('Pedido não encontrado')

      const { data: items } = await request.supabase
        .from('order_items')
        .select(ORDER_ITEM_COLUMNS)
        .eq('order_id', request.params.id)

      return toOrder(order, items ?? [])
    },
  )

  app.get(
    '/orders/:id/timeline',
    {
      onRequest: app.requireAuth,
      schema: {
        tags: ['pedidos'],
        description: 'Linha do tempo de status do pedido (base do rastreamento).',
        params: OrderParams,
        response: { 200: Type.Array(OrderStatusEvent), ...StandardErrors },
      },
    },
    async (request) => {
      const { data, error } = await request.supabase
        .from('order_status_events')
        .select('id, status, note, created_at')
        .eq('order_id', request.params.id)
        .order('created_at', { ascending: true })

      if (error) throw app.httpErrors.internalServerError(error.message)

      return (data ?? []).map((row: Record<string, unknown>) => ({
        id: String(row.id),
        status: row.status as never,
        note: (row.note as string | null) ?? null,
        createdAt: String(row.created_at),
      }))
    },
  )

  app.patch(
    '/orders/:id/status',
    {
      onRequest: app.requireAuth,
      schema: {
        tags: ['pedidos'],
        description:
          'Avança o status do pedido. Staff conduz o fluxo; o cliente só pode cancelar antes da confirmação.',
        params: OrderParams,
        body: AdvanceStatusInput,
        response: { 200: AdvanceStatusResult, ...StandardErrors },
      },
    },
    async (request) => {
      const { data, error } = await request.supabase.rpc('advance_order_status', {
        p_order_id: request.params.id,
        p_status: request.body.status,
        p_note: request.body.note ?? null,
      })

      if (error) throw app.httpErrors.internalServerError(error.message)

      const result = data as { ok: boolean; error: string | null; status: string | null }
      if (!result.ok) {
        const mapped = mapAdvanceError(result.error ?? 'desconhecido')
        throw app.httpErrors.createError(mapped.status, mapped.message)
      }

      return { id: request.params.id, status: request.body.status }
    },
  )
}

export default orderRoutes
