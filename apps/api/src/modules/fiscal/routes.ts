import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import { Money, StandardErrors, Uuid } from '@vendas-bot/shared'

const DOCUMENT_STATUSES = [
  'draft',
  'queued',
  'transmitting',
  'authorized',
  'rejected',
  'canceled',
  'contingency',
  'denied',
] as const
const DocumentStatusSchema = Type.Union(DOCUMENT_STATUSES.map((status) => Type.Literal(status)))
const ModelSchema = Type.Union([Type.Literal('nfce'), Type.Literal('nfe')])

/** Contrato de saída do perfil tributário resolvido de um produto. */
const TaxProfile = Type.Object({
  ncm: Type.Optional(Type.String()),
  cest: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  cfop: Type.Optional(Type.String()),
  icmsCst: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  icmsRate: Type.Optional(Type.Number()),
  pisCst: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  pisRate: Type.Optional(Type.Number()),
  cofinsCst: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  cofinsRate: Type.Optional(Type.Number()),
  commercialUnit: Type.Optional(Type.String()),
  /** De onde veio: perfil do produto, padrão do estabelecimento ou nenhum. */
  source: Type.Union([
    Type.Literal('product'),
    Type.Literal('tenant_default'),
    Type.Literal('none'),
  ]),
})

const TaxProfileInput = Type.Object({
  productId: Type.Optional(Type.Union([Uuid, Type.Null()])),
  isDefault: Type.Optional(Type.Boolean()),
  ncm: Type.String({ pattern: '^[0-9]{8}$' }),
  cest: Type.Optional(Type.Union([Type.String({ pattern: '^[0-9]{7}$' }), Type.Null()])),
  cfop: Type.String({ pattern: '^[0-9]{4}$' }),
  icmsCst: Type.Optional(Type.Union([Type.String({ pattern: '^[0-9]{2,3}$' }), Type.Null()])),
  icmsRate: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  pisCst: Type.Optional(Type.Union([Type.String({ pattern: '^[0-9]{2}$' }), Type.Null()])),
  pisRate: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  cofinsCst: Type.Optional(Type.Union([Type.String({ pattern: '^[0-9]{2}$' }), Type.Null()])),
  cofinsRate: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  commercialUnit: Type.Optional(Type.String({ maxLength: 6 })),
})

/** Contrato de saída de um documento fiscal. */
const FiscalDocument = Type.Object({
  id: Uuid,
  orderId: Uuid,
  model: ModelSchema,
  status: DocumentStatusSchema,
  environment: Type.Union([Type.Literal('production'), Type.Literal('homologation')]),
  series: Type.Integer(),
  number: Type.Union([Type.Integer(), Type.Null()]),
  accessKey: Type.Union([Type.String(), Type.Null()]),
  protocol: Type.Union([Type.String(), Type.Null()]),
  totalAmount: Money,
  totalTaxes: Type.Number(),
  rejectionReason: Type.Union([Type.String(), Type.Null()]),
  danfeUrl: Type.Union([Type.String(), Type.Null()]),
  authorizedAt: Type.Union([Type.String(), Type.Null()]),
  canceledAt: Type.Union([Type.String(), Type.Null()]),
  attempts: Type.Integer(),
})

const DOCUMENT_COLUMNS =
  'id, order_id, model, status, environment, series, number, access_key, protocol, total_amount, total_taxes, rejection_reason, danfe_url, authorized_at, canceled_at, attempts'

interface DocumentRow {
  id: string
  order_id: string
  model: 'nfce' | 'nfe'
  status: (typeof DOCUMENT_STATUSES)[number]
  environment: 'production' | 'homologation'
  series: number
  number: number | null
  access_key: string | null
  protocol: string | null
  total_amount: string | number
  total_taxes: string | number
  rejection_reason: string | null
  danfe_url: string | null
  authorized_at: string | null
  canceled_at: string | null
  attempts: number
}

/** Contrato: (row) -> FiscalDocument */
export function toFiscalDocument(row: DocumentRow) {
  return {
    id: row.id,
    orderId: row.order_id,
    model: row.model,
    status: row.status,
    environment: row.environment,
    series: row.series,
    number: row.number,
    accessKey: row.access_key,
    protocol: row.protocol,
    totalAmount: Number(row.total_amount),
    totalTaxes: Number(row.total_taxes),
    rejectionReason: row.rejection_reason,
    danfeUrl: row.danfe_url,
    authorizedAt: row.authorized_at,
    canceledAt: row.canceled_at,
    attempts: row.attempts,
  }
}

const fiscalRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/fiscal/tax-profile/:productId',
    {
      onRequest: app.requirePermission('fiscal.read'),
      schema: {
        tags: ['fiscal'],
        description:
          'Tributação aplicável a um produto, caindo para o padrão do estabelecimento quando não houver perfil próprio.',
        params: Type.Object({ productId: Uuid }),
        response: { 200: TaxProfile, ...StandardErrors },
      },
    },
    async (request) => {
      const { data, error } = await request.supabase.rpc('resolve_tax_profile', {
        p_product_id: request.params.productId,
      })
      if (error) throw app.httpErrors.internalServerError(error.message)

      const profile = (data ?? { source: 'none' }) as Record<string, unknown>
      return {
        ...(profile.ncm ? { ncm: String(profile.ncm) } : {}),
        ...(profile.cest !== undefined ? { cest: (profile.cest as string | null) ?? null } : {}),
        ...(profile.cfop ? { cfop: String(profile.cfop) } : {}),
        ...(profile.icmsCst !== undefined ? { icmsCst: (profile.icmsCst as string | null) ?? null } : {}),
        ...(profile.icmsRate !== undefined ? { icmsRate: Number(profile.icmsRate) } : {}),
        ...(profile.pisCst !== undefined ? { pisCst: (profile.pisCst as string | null) ?? null } : {}),
        ...(profile.pisRate !== undefined ? { pisRate: Number(profile.pisRate) } : {}),
        ...(profile.cofinsCst !== undefined ? { cofinsCst: (profile.cofinsCst as string | null) ?? null } : {}),
        ...(profile.cofinsRate !== undefined ? { cofinsRate: Number(profile.cofinsRate) } : {}),
        ...(profile.commercialUnit ? { commercialUnit: String(profile.commercialUnit) } : {}),
        source: (profile.source ?? 'none') as never,
      }
    },
  )

  app.post(
    '/fiscal/tax-profiles',
    {
      onRequest: app.requirePermission('fiscal.write'),
      schema: {
        tags: ['fiscal'],
        description: 'Cadastra a tributação de um produto ou o padrão do estabelecimento.',
        body: TaxProfileInput,
        response: { 201: Type.Object({ id: Uuid }), ...StandardErrors },
      },
    },
    async (request, reply) => {
      const tenantId = request.requireTenantId()
      const { data, error } = await request.supabase
        .from('product_tax_profiles')
        .insert({
          tenant_id: tenantId,
          product_id: request.body.productId ?? null,
          is_default: request.body.isDefault ?? false,
          ncm: request.body.ncm,
          cest: request.body.cest ?? null,
          cfop: request.body.cfop,
          icms_cst: request.body.icmsCst ?? null,
          icms_rate: request.body.icmsRate ?? 0,
          pis_cst: request.body.pisCst ?? null,
          pis_rate: request.body.pisRate ?? 0,
          cofins_cst: request.body.cofinsCst ?? null,
          cofins_rate: request.body.cofinsRate ?? 0,
          commercial_unit: request.body.commercialUnit ?? 'UN',
        })
        .select('id')
        .single()

      if (error) throw app.httpErrors.badRequest(error.message)
      return reply.status(201).send({ id: data.id })
    },
  )

  app.get(
    '/fiscal/documents',
    {
      onRequest: app.requirePermission('fiscal.read'),
      schema: {
        tags: ['fiscal'],
        description: 'Documentos fiscais do estabelecimento.',
        querystring: Type.Object({ status: Type.Optional(DocumentStatusSchema) }),
        response: { 200: Type.Array(FiscalDocument), ...StandardErrors },
      },
    },
    async (request) => {
      let query = request.supabase
        .from('fiscal_documents')
        .select(DOCUMENT_COLUMNS)
        .order('created_at', { ascending: false })
        .limit(100)

      if (request.query.status) query = query.eq('status', request.query.status)

      const { data, error } = await query
      if (error) throw app.httpErrors.internalServerError(error.message)
      return (data ?? []).map(toFiscalDocument)
    },
  )
}

export default fiscalRoutes
