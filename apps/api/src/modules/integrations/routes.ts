import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import { StandardErrors, Uuid } from '@vendas-bot/shared'
import { SYNC_INTEGRATION_COLUMNS, runSyncCycle, SyncCycleError } from './service.js'
import type { IntegrationRecord } from './service.js'

const ChannelSchema = Type.Union([Type.Literal('ifood'), Type.Literal('ubereats')])
const StatusSchema = Type.Union([
  Type.Literal('disconnected'),
  Type.Literal('connected'),
  Type.Literal('error'),
  Type.Literal('paused'),
])

/** Contrato de saída de um canal conectado. Nunca inclui segredo. */
const Integration = Type.Object({
  id: Uuid,
  channel: ChannelSchema,
  status: StatusSchema,
  externalStoreId: Type.Union([Type.String(), Type.Null()]),
  storeName: Type.Union([Type.String(), Type.Null()]),
  autoAccept: Type.Boolean(),
  isReceiving: Type.Boolean(),
  lastSyncAt: Type.Union([Type.String(), Type.Null()]),
  lastError: Type.Union([Type.String(), Type.Null()]),
  /** Quantos itens do parceiro ainda não têm produto interno correspondente. */
  hasCredentials: Type.Boolean(),
})

const ItemMap = Type.Object({
  id: Uuid,
  productId: Type.Union([Uuid, Type.Null()]),
  optionId: Type.Union([Uuid, Type.Null()]),
  externalItemId: Type.String(),
  externalName: Type.Union([Type.String(), Type.Null()]),
})

const IntegrationEvent = Type.Object({
  id: Uuid,
  eventCode: Type.String(),
  externalOrderId: Type.Union([Type.String(), Type.Null()]),
  orderId: Type.Union([Uuid, Type.Null()]),
  processedAt: Type.Union([Type.String(), Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
})

const INTEGRATION_COLUMNS =
  'id, channel, status, external_store_id, store_name, auto_accept, is_receiving, last_sync_at, last_error'

interface IntegrationRow {
  id: string
  channel: 'ifood' | 'ubereats'
  status: 'disconnected' | 'connected' | 'error' | 'paused'
  external_store_id: string | null
  store_name: string | null
  auto_accept: boolean
  is_receiving: boolean
  last_sync_at: string | null
  last_error: string | null
}

/** Contrato: (row, hasCredentials) -> Integration */
export function toIntegration(row: IntegrationRow, hasCredentials: boolean) {
  return {
    id: row.id,
    channel: row.channel,
    status: row.status,
    externalStoreId: row.external_store_id,
    storeName: row.store_name,
    autoAccept: row.auto_accept,
    isReceiving: row.is_receiving,
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
    hasCredentials,
  }
}

const SyncSummary = Type.Object({
  polled: Type.Integer(),
  ingested: Type.Integer(),
  duplicated: Type.Integer(),
  failed: Type.Integer(),
  /** Itens do parceiro sem produto interno: não baixam estoque. */
  unmapped: Type.Array(Type.String()),
})

const integrationRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/integrations/:id/sync',
    {
      onRequest: app.requirePermission('integrations.write'),
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        tags: ['integrações'],
        description:
          'Roda um ciclo de sincronização do canal (polling do iFood). Canais por webhook não têm o que consultar.',
        params: Type.Object({ id: Uuid }),
        response: { 200: SyncSummary, ...StandardErrors },
      },
    },
    async (request) => {
      const tenantId = request.requireTenantId()

      const { data: integration } = await app.supabaseAdmin
        .from('integrations')
        .select(SYNC_INTEGRATION_COLUMNS)
        .eq('id', request.params.id)
        .eq('tenant_id', tenantId)
        .maybeSingle()

      if (!integration) throw app.httpErrors.notFound('Integração não encontrada')

      try {
        // Mesmo ciclo que o worker roda em laço — uma implementação só.
        return await runSyncCycle({
          integration: integration as IntegrationRecord,
          supabaseAdmin: app.supabaseAdmin,
          logger: request.log,
        })
      } catch (error) {
        if (error instanceof SyncCycleError) {
          throw error.reason === 'sem_credenciais'
            ? app.httpErrors.badRequest(error.message)
            : app.httpErrors.badGateway(error.message)
        }
        throw error
      }
    },
  )

  app.get(
    '/integrations',
    {
      onRequest: app.requirePermission('integrations.read'),
      schema: {
        tags: ['integrações'],
        description: 'Canais de marketplace do estabelecimento.',
        response: { 200: Type.Array(Integration), ...StandardErrors },
      },
    },
    async (request) => {
      const { data, error } = await request.supabase
        .from('integrations')
        .select(INTEGRATION_COLUMNS)
        .order('channel', { ascending: true })

      if (error) throw app.httpErrors.internalServerError(error.message)

      const rows = (data ?? []) as IntegrationRow[]
      if (rows.length === 0) return []

      // A existência da credencial é informada sem expor o segredo.
      const { data: credentials } = await app.supabaseAdmin
        .from('integration_credentials')
        .select('integration_id')
        .in(
          'integration_id',
          rows.map((row) => row.id),
        )

      const configured = new Set((credentials ?? []).map((row) => String(row.integration_id)))
      return rows.map((row) => toIntegration(row, configured.has(row.id)))
    },
  )

  app.post(
    '/integrations',
    {
      onRequest: app.requirePermission('integrations.write'),
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['integrações'],
        description:
          'Conecta um canal. As credenciais vão para uma tabela que só o backend lê.',
        body: Type.Object({
          channel: ChannelSchema,
          externalStoreId: Type.String({ minLength: 1, maxLength: 120 }),
          storeName: Type.Optional(Type.Union([Type.String({ maxLength: 160 }), Type.Null()])),
          clientId: Type.String({ minLength: 1, maxLength: 200 }),
          clientSecret: Type.String({ minLength: 1, maxLength: 400 }),
          webhookSecret: Type.Optional(Type.Union([Type.String({ maxLength: 400 }), Type.Null()])),
          autoAccept: Type.Optional(Type.Boolean()),
        }),
        response: { 201: Type.Object({ id: Uuid }), ...StandardErrors },
      },
    },
    async (request, reply) => {
      const tenantId = request.requireTenantId()

      const { data, error } = await request.supabase
        .from('integrations')
        .upsert(
          {
            tenant_id: tenantId,
            channel: request.body.channel,
            status: 'connected',
            external_store_id: request.body.externalStoreId,
            store_name: request.body.storeName ?? null,
            auto_accept: request.body.autoAccept ?? false,
          },
          { onConflict: 'tenant_id,channel' },
        )
        .select('id')
        .single()

      if (error) throw app.httpErrors.badRequest(error.message)

      const { error: credentialError } = await app.supabaseAdmin
        .from('integration_credentials')
        .upsert(
          {
            integration_id: data.id,
            client_id: request.body.clientId,
            client_secret: request.body.clientSecret,
            webhook_secret: request.body.webhookSecret ?? null,
            // Token em cache é invalidado: as credenciais mudaram.
            access_token: null,
            token_expires_at: null,
          },
          { onConflict: 'integration_id' },
        )

      if (credentialError) throw app.httpErrors.internalServerError(credentialError.message)

      return reply.status(201).send({ id: data.id })
    },
  )

  app.patch(
    '/integrations/:id',
    {
      onRequest: app.requirePermission('integrations.write'),
      schema: {
        tags: ['integrações'],
        description: 'Pausa o recebimento, liga o aceite automático ou renomeia a loja.',
        params: Type.Object({ id: Uuid }),
        body: Type.Object({
          isReceiving: Type.Optional(Type.Boolean()),
          autoAccept: Type.Optional(Type.Boolean()),
          storeName: Type.Optional(Type.Union([Type.String({ maxLength: 160 }), Type.Null()])),
        }),
        response: { 200: Integration, ...StandardErrors },
      },
    },
    async (request) => {
      const patch: Record<string, unknown> = {}
      if (request.body.isReceiving !== undefined) patch.is_receiving = request.body.isReceiving
      if (request.body.autoAccept !== undefined) patch.auto_accept = request.body.autoAccept
      if (request.body.storeName !== undefined) patch.store_name = request.body.storeName

      const { data, error } = await request.supabase
        .from('integrations')
        .update(patch)
        .eq('id', request.params.id)
        .select(INTEGRATION_COLUMNS)
        .maybeSingle()

      if (error) throw app.httpErrors.badRequest(error.message)
      if (!data) throw app.httpErrors.notFound('Integração não encontrada')
      return toIntegration(data as IntegrationRow, true)
    },
  )

  app.get(
    '/integrations/:id/items',
    {
      onRequest: app.requirePermission('integrations.read'),
      schema: {
        tags: ['integrações'],
        description: 'Mapeamento entre itens do parceiro e produtos internos.',
        params: Type.Object({ id: Uuid }),
        response: { 200: Type.Array(ItemMap), ...StandardErrors },
      },
    },
    async (request) => {
      const { data, error } = await request.supabase
        .from('integration_item_map')
        .select('id, product_id, option_id, external_item_id, external_name')
        .eq('integration_id', request.params.id)
        .order('external_name', { ascending: true })

      if (error) throw app.httpErrors.internalServerError(error.message)
      return (data ?? []).map((row: Record<string, unknown>) => ({
        id: String(row.id),
        productId: (row.product_id as string | null) ?? null,
        optionId: (row.option_id as string | null) ?? null,
        externalItemId: String(row.external_item_id),
        externalName: (row.external_name as string | null) ?? null,
      }))
    },
  )

  app.post(
    '/integrations/:id/items',
    {
      onRequest: app.requirePermission('integrations.write'),
      schema: {
        tags: ['integrações'],
        description:
          'Liga um item do parceiro a um produto interno. Sem isso, o pedido entra mas não baixa estoque.',
        params: Type.Object({ id: Uuid }),
        body: Type.Object({
          externalItemId: Type.String({ minLength: 1, maxLength: 200 }),
          externalName: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
          productId: Type.Optional(Type.Union([Uuid, Type.Null()])),
          optionId: Type.Optional(Type.Union([Uuid, Type.Null()])),
        }),
        response: { 201: ItemMap, ...StandardErrors },
      },
    },
    async (request, reply) => {
      const tenantId = request.requireTenantId()
      const { data, error } = await request.supabase
        .from('integration_item_map')
        .upsert(
          {
            tenant_id: tenantId,
            integration_id: request.params.id,
            external_item_id: request.body.externalItemId,
            external_name: request.body.externalName ?? null,
            product_id: request.body.productId ?? null,
            option_id: request.body.optionId ?? null,
          },
          { onConflict: 'integration_id,external_item_id' },
        )
        .select('id, product_id, option_id, external_item_id, external_name')
        .single()

      if (error) throw app.httpErrors.badRequest(error.message)
      return reply.status(201).send({
        id: data.id,
        productId: data.product_id,
        optionId: data.option_id,
        externalItemId: data.external_item_id,
        externalName: data.external_name,
      })
    },
  )

  app.get(
    '/integrations/:id/events',
    {
      onRequest: app.requirePermission('integrations.read'),
      schema: {
        tags: ['integrações'],
        description: 'Últimos eventos recebidos do parceiro.',
        params: Type.Object({ id: Uuid }),
        response: { 200: Type.Array(IntegrationEvent), ...StandardErrors },
      },
    },
    async (request) => {
      const { data, error } = await request.supabase
        .from('integration_events')
        .select('id, event_code, external_order_id, order_id, processed_at, error, created_at')
        .eq('integration_id', request.params.id)
        .order('created_at', { ascending: false })
        .limit(50)

      if (error) throw app.httpErrors.internalServerError(error.message)
      return (data ?? []).map((row: Record<string, unknown>) => ({
        id: String(row.id),
        eventCode: String(row.event_code),
        externalOrderId: (row.external_order_id as string | null) ?? null,
        orderId: (row.order_id as string | null) ?? null,
        processedAt: (row.processed_at as string | null) ?? null,
        error: (row.error as string | null) ?? null,
        createdAt: String(row.created_at),
      }))
    },
  )
}

export default integrationRoutes
