import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import { StandardErrors, Uuid } from '@vendas-bot/shared'

export const PREP_STATUSES = ['pending', 'preparing', 'ready', 'served', 'canceled'] as const
export type PrepStatus = (typeof PREP_STATUSES)[number]
const PrepStatusSchema = Type.Union(PREP_STATUSES.map((status) => Type.Literal(status)))

/** Contrato de saída de um item na fila da cozinha. */
const QueueItem = Type.Object({
  orderId: Uuid,
  orderNumber: Type.Integer(),
  /** Canal de venda: próprio, iFood ou Uber Eats. */
  origin: Type.Union([Type.Literal('own'), Type.Literal('ifood'), Type.Literal('ubereats')]),
  /** Código curto do parceiro, que o entregador informa. */
  externalDisplayId: Type.Union([Type.String(), Type.Null()]),
  channel: Type.String(),
  tableLabel: Type.Union([Type.String(), Type.Null()]),
  itemId: Uuid,
  productName: Type.String(),
  quantity: Type.Number(),
  notes: Type.Union([Type.String(), Type.Null()]),
  selectedOptions: Type.Array(
    Type.Object({ groupName: Type.String(), optionName: Type.String() }),
  ),
  prepStatus: PrepStatusSchema,
  waitingSeconds: Type.Integer(),
})

const IdParams = Type.Object({ id: Uuid })

/**
 * Espelho de public.can_transition_prep.
 * Contrato: (from, to) -> boolean
 */
export function canTransitionPrep(from: PrepStatus, to: PrepStatus): boolean {
  const allowed: Record<PrepStatus, PrepStatus[]> = {
    pending: ['preparing', 'ready', 'canceled'],
    preparing: ['ready', 'canceled'],
    ready: ['served', 'preparing'],
    served: [],
    canceled: [],
  }
  return allowed[from].includes(to)
}

const kdsRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/kds/queue',
    {
      onRequest: app.requirePermission('kds.read'),
      schema: {
        tags: ['cozinha'],
        description: 'Fila de preparo do estabelecimento, mais antigos primeiro.',
        response: { 200: Type.Array(QueueItem), ...StandardErrors },
      },
    },
    async (request) => {
      const tenantId = request.requireTenantId()
      // v2 traz a origem do pedido; a v1 segue disponível para quem a consome.
      const { data, error } = await request.supabase.rpc('kds_queue_v2', { p_tenant_id: tenantId })
      if (error) throw app.httpErrors.internalServerError(error.message)

      return (data ?? []).map((row: Record<string, unknown>) => {
        const options = Array.isArray(row.selected_options)
          ? (row.selected_options as Array<Record<string, unknown>>)
          : []
        return {
          orderId: String(row.order_id),
          orderNumber: Number(row.order_number),
          origin: (row.origin ?? 'own') as 'own' | 'ifood' | 'ubereats',
          externalDisplayId: (row.external_display_id as string | null) ?? null,
          channel: String(row.channel),
          tableLabel: (row.table_label as string | null) ?? null,
          itemId: String(row.item_id),
          productName: String(row.product_name),
          quantity: Number(row.quantity),
          notes: (row.notes as string | null) ?? null,
          selectedOptions: options.map((option) => ({
            groupName: String(option.groupName ?? ''),
            optionName: String(option.optionName ?? ''),
          })),
          prepStatus: row.prep_status as PrepStatus,
          waitingSeconds: Number(row.waiting_seconds),
        }
      })
    },
  )

  app.patch(
    '/kds/items/:id',
    {
      onRequest: app.requirePermission('kds.update_status'),
      schema: {
        tags: ['cozinha'],
        description: 'Avança o preparo de um item da fila.',
        params: IdParams,
        body: Type.Object({ status: PrepStatusSchema }),
        response: {
          200: Type.Object({ itemStatus: PrepStatusSchema, orderReady: Type.Boolean() }),
          ...StandardErrors,
        },
      },
    },
    async (request) => {
      const { data, error } = await request.supabase.rpc('advance_item_prep', {
        p_item_id: request.params.id,
        p_status: request.body.status,
      })
      if (error) throw app.httpErrors.internalServerError(error.message)

      const result = data as {
        ok: boolean
        error: string | null
        itemStatus: string | null
        orderReady: boolean
      }
      if (!result.ok) {
        const status =
          result.error === 'item_nao_encontrado' ? 404 : result.error === 'nao_autorizado' ? 403 : 409
        const message =
          result.error === 'item_nao_encontrado'
            ? 'Item não encontrado.'
            : result.error === 'nao_autorizado'
              ? 'Este item pertence a outro estabelecimento.'
              : 'Esta mudança de preparo não é permitida a partir do estado atual.'
        throw app.httpErrors.createError(status, message)
      }

      return { itemStatus: result.itemStatus as PrepStatus, orderReady: result.orderReady }
    },
  )
}

export default kdsRoutes
