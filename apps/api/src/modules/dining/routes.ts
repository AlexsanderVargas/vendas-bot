import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import { StandardErrors, Uuid } from '@vendas-bot/shared'

export const TABLE_STATUSES = [
  'free',
  'occupied',
  'billing',
  'cleaning',
  'reserved',
  'inactive',
] as const
export type TableStatus = (typeof TABLE_STATUSES)[number]
const TableStatusSchema = Type.Union(TABLE_STATUSES.map((status) => Type.Literal(status)))

/** Contrato de saída de uma mesa do salão. */
const DiningTable = Type.Object({
  id: Uuid,
  label: Type.String(),
  seats: Type.Integer(),
  status: TableStatusSchema,
  sectorId: Type.Union([Uuid, Type.Null()]),
  sectorName: Type.Union([Type.String(), Type.Null()]),
  mapX: Type.Union([Type.Number(), Type.Null()]),
  mapY: Type.Union([Type.Number(), Type.Null()]),
})

const Sector = Type.Object({
  id: Uuid,
  name: Type.String(),
  sortOrder: Type.Integer(),
  isActive: Type.Boolean(),
})

const TableInput = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 20 }),
  seats: Type.Optional(Type.Integer({ minimum: 1, maximum: 99 })),
  sectorId: Type.Optional(Type.Union([Uuid, Type.Null()])),
  mapX: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 100 }), Type.Null()])),
  mapY: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 100 }), Type.Null()])),
})

const SectorInput = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  sortOrder: Type.Optional(Type.Integer({ minimum: 0 })),
})

const StatusInput = Type.Object({ status: TableStatusSchema })
const IdParams = Type.Object({ id: Uuid })

/**
 * Espelho de public.can_transition_table — permite a UI desabilitar ações
 * impossíveis antes de chamar o servidor, que revalida.
 * Contrato: (from, to) -> boolean
 */
export function canTransitionTable(from: TableStatus, to: TableStatus): boolean {
  if (from === to) return true
  if (to === 'inactive' || from === 'inactive') return true
  const allowed: Record<TableStatus, TableStatus[]> = {
    free: ['occupied', 'reserved', 'cleaning'],
    reserved: ['occupied', 'free'],
    occupied: ['billing', 'cleaning'],
    billing: ['cleaning', 'occupied'],
    cleaning: ['free'],
    inactive: [],
  }
  return allowed[from].includes(to)
}

/** Erros de comanda -> status HTTP. */
const COMANDA_ERROR: Record<string, { status: number; message: string }> = {
  mesa_nao_encontrada: { status: 404, message: 'Mesa não encontrada.' },
  pedido_nao_encontrado: { status: 404, message: 'Comanda não encontrada.' },
  nao_autorizado: { status: 403, message: 'Esta mesa pertence a outro estabelecimento.' },
  mesa_indisponivel: { status: 409, message: 'Mesa fora de uso.' },
  comanda_ja_aberta: { status: 409, message: 'Esta mesa já tem uma comanda aberta.' },
  pedido_fechado: { status: 409, message: 'Comanda encerrada não aceita novos itens.' },
  produto_indisponivel: { status: 409, message: 'Produto indisponível.' },
  opcional_invalido: { status: 400, message: 'Opcional inválido para este produto.' },
  opcionais_obrigatorios: { status: 400, message: 'Revise os opcionais obrigatórios do item.' },
}

/** Contrato: (error) -> { status, message } */
export function mapComandaError(error: string): { status: number; message: string } {
  return COMANDA_ERROR[error] ?? { status: 400, message: 'Não foi possível concluir a operação.' }
}

const diningRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/dining/tables/:id/order',
    {
      onRequest: app.requirePermission('orders.create'),
      schema: {
        tags: ['comandas'],
        description: 'Abre a comanda da mesa e a marca como ocupada.',
        params: IdParams,
        body: Type.Object({
          notes: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
        }),
        response: {
          201: Type.Object({ orderId: Uuid, orderNumber: Type.Integer() }),
          ...StandardErrors,
        },
      },
    },
    async (request, reply) => {
      const { data, error } = await request.supabase.rpc('open_table_order', {
        p_table_id: request.params.id,
        p_notes: request.body.notes ?? null,
      })
      if (error) throw app.httpErrors.internalServerError(error.message)

      const result = data as { ok: boolean; error: string | null; orderId: string | null; orderNumber: number | null }
      if (!result.ok || !result.orderId) {
        const mapped = mapComandaError(result.error ?? 'desconhecido')
        throw app.httpErrors.createError(mapped.status, mapped.message)
      }
      return reply.status(201).send({
        orderId: result.orderId,
        orderNumber: Number(result.orderNumber),
      })
    },
  )

  app.post(
    '/orders/:id/items',
    {
      onRequest: app.requirePermission('orders.create'),
      schema: {
        tags: ['comandas'],
        description: 'Lança um item na comanda. O preço é sempre recalculado no servidor.',
        params: IdParams,
        body: Type.Object({
          productId: Uuid,
          quantity: Type.Number({ exclusiveMinimum: 0, maximum: 999 }),
          optionIds: Type.Array(Uuid, { maxItems: 30, default: [] }),
          notes: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
        }),
        response: {
          201: Type.Object({ itemId: Uuid, unitPrice: Type.Number(), orderTotal: Type.Number() }),
          ...StandardErrors,
        },
      },
    },
    async (request, reply) => {
      const { data, error } = await request.supabase.rpc('add_order_item', {
        p_order_id: request.params.id,
        p_product_id: request.body.productId,
        p_quantity: request.body.quantity,
        p_option_ids: request.body.optionIds,
        p_notes: request.body.notes ?? null,
      })
      if (error) throw app.httpErrors.internalServerError(error.message)

      const result = data as { ok: boolean; error: string | null; itemId: string | null; unitPrice: number; orderTotal: number }
      if (!result.ok || !result.itemId) {
        const mapped = mapComandaError(result.error ?? 'desconhecido')
        throw app.httpErrors.createError(mapped.status, mapped.message)
      }
      return reply.status(201).send({
        itemId: result.itemId,
        unitPrice: Number(result.unitPrice),
        orderTotal: Number(result.orderTotal),
      })
    },
  )

  app.post(
    '/orders/:id/close',
    {
      onRequest: app.requirePermission('orders.update_status'),
      schema: {
        tags: ['comandas'],
        description: 'Fecha a conta da mesa (status da mesa vai para cobrança).',
        params: IdParams,
        response: { 200: Type.Object({ total: Type.Number() }), ...StandardErrors },
      },
    },
    async (request) => {
      const { data, error } = await request.supabase.rpc('close_table_order', {
        p_order_id: request.params.id,
      })
      if (error) throw app.httpErrors.internalServerError(error.message)

      const result = data as { ok: boolean; error: string | null; total: number | null }
      if (!result.ok) {
        const mapped = mapComandaError(result.error ?? 'desconhecido')
        throw app.httpErrors.createError(mapped.status, mapped.message)
      }
      return { total: Number(result.total) }
    },
  )

  app.get(
    '/dining/tables',
    {
      onRequest: app.requirePermission('tables.read'),
      schema: {
        tags: ['salão'],
        description: 'Mapa do salão com o status de cada mesa.',
        response: { 200: Type.Array(DiningTable), ...StandardErrors },
      },
    },
    async (request) => {
      const { data, error } = await request.supabase
        .from('dining_tables')
        .select('id, label, seats, status, sector_id, map_x, map_y, dining_sectors(name)')
        .order('label', { ascending: true })

      if (error) throw app.httpErrors.internalServerError(error.message)

      return (data ?? []).map((row: Record<string, unknown>) => {
        const sector = (row.dining_sectors ?? null) as { name?: string } | null
        return {
          id: String(row.id),
          label: String(row.label),
          seats: Number(row.seats),
          status: row.status as TableStatus,
          sectorId: (row.sector_id as string | null) ?? null,
          sectorName: sector?.name ?? null,
          mapX: row.map_x === null ? null : Number(row.map_x),
          mapY: row.map_y === null ? null : Number(row.map_y),
        }
      })
    },
  )

  app.post(
    '/dining/tables',
    {
      onRequest: app.requirePermission('tables.write'),
      schema: {
        tags: ['salão'],
        description: 'Cadastra uma mesa.',
        body: TableInput,
        response: { 201: Type.Object({ id: Uuid }), ...StandardErrors },
      },
    },
    async (request, reply) => {
      const tenantId = request.requireTenantId()
      const { data, error } = await request.supabase
        .from('dining_tables')
        .insert({
          tenant_id: tenantId,
          label: request.body.label,
          seats: request.body.seats ?? 4,
          sector_id: request.body.sectorId ?? null,
          map_x: request.body.mapX ?? null,
          map_y: request.body.mapY ?? null,
        })
        .select('id')
        .single()

      if (error) throw app.httpErrors.badRequest(error.message)
      return reply.status(201).send({ id: data.id })
    },
  )

  app.patch(
    '/dining/tables/:id/status',
    {
      onRequest: app.requirePermission('tables.write'),
      schema: {
        tags: ['salão'],
        description: 'Muda o status da mesa. Transições inválidas são recusadas.',
        params: IdParams,
        body: StatusInput,
        response: { 200: Type.Object({ id: Uuid, status: TableStatusSchema }), ...StandardErrors },
      },
    },
    async (request) => {
      const { data, error } = await request.supabase
        .from('dining_tables')
        .update({ status: request.body.status })
        .eq('id', request.params.id)
        .select('id, status')
        .maybeSingle()

      // O guard do banco levanta check_violation em transição inválida.
      if (error) {
        throw app.httpErrors.conflict(
          error.message.includes('inválida')
            ? 'Esta mudança de status de mesa não é permitida a partir do estado atual.'
            : error.message,
        )
      }
      if (!data) throw app.httpErrors.notFound('Mesa não encontrada')
      return { id: data.id, status: data.status }
    },
  )

  app.get(
    '/dining/sectors',
    {
      onRequest: app.requirePermission('tables.read'),
      schema: {
        tags: ['salão'],
        description: 'Setores do salão.',
        response: { 200: Type.Array(Sector), ...StandardErrors },
      },
    },
    async (request) => {
      const { data, error } = await request.supabase
        .from('dining_sectors')
        .select('id, name, sort_order, is_active')
        .order('sort_order', { ascending: true })

      if (error) throw app.httpErrors.internalServerError(error.message)
      return (data ?? []).map((row: Record<string, unknown>) => ({
        id: String(row.id),
        name: String(row.name),
        sortOrder: Number(row.sort_order),
        isActive: Boolean(row.is_active),
      }))
    },
  )

  app.post(
    '/dining/sectors',
    {
      onRequest: app.requirePermission('tables.write'),
      schema: {
        tags: ['salão'],
        description: 'Cadastra um setor do salão.',
        body: SectorInput,
        response: { 201: Type.Object({ id: Uuid }), ...StandardErrors },
      },
    },
    async (request, reply) => {
      const tenantId = request.requireTenantId()
      const { data, error } = await request.supabase
        .from('dining_sectors')
        .insert({
          tenant_id: tenantId,
          name: request.body.name,
          sort_order: request.body.sortOrder ?? 0,
        })
        .select('id')
        .single()

      if (error) throw app.httpErrors.badRequest(error.message)
      return reply.status(201).send({ id: data.id })
    },
  )
}

export default diningRoutes
