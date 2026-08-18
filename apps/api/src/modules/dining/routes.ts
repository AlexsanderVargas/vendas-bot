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

const diningRoutes: FastifyPluginAsyncTypebox = async (app) => {
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
