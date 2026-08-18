import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import { ErrorResponse, Money, Slug, StandardErrors, Uuid } from '@vendas-bot/shared'
import { resolveCustomerContext } from '../../lib/customer.js'

/** Contrato de saída do extrato de fidelidade. */
const LoyaltyStatement = Type.Object({
  balance: Type.Integer(),
  transactions: Type.Array(
    Type.Object({
      id: Uuid,
      type: Type.Union([
        Type.Literal('earn'),
        Type.Literal('redeem'),
        Type.Literal('adjust'),
        Type.Literal('expire'),
      ]),
      points: Type.Integer(),
      cashback: Money,
      description: Type.Union([Type.String(), Type.Null()]),
      createdAt: Type.String(),
    }),
  ),
})

const ReviewInput = Type.Object({
  rating: Type.Integer({ minimum: 1, maximum: 5 }),
  comment: Type.Optional(Type.Union([Type.String({ maxLength: 1000 }), Type.Null()])),
})

const ReviewResult = Type.Object({ reviewId: Uuid })

/** Contrato de saída do resumo público de reputação. */
const ReputationSummary = Type.Object({
  total: Type.Integer(),
  average: Type.Number(),
  promoters: Type.Integer(),
  neutrals: Type.Integer(),
  detractors: Type.Integer(),
  nps: Type.Number(),
  reviews: Type.Array(
    Type.Object({
      id: Uuid,
      rating: Type.Integer(),
      comment: Type.Union([Type.String(), Type.Null()]),
      createdAt: Type.String(),
    }),
  ),
})

const REVIEW_ERROR_STATUS: Record<string, number> = {
  pedido_nao_encontrado: 404,
  nao_autorizado: 403,
  pedido_nao_concluido: 409,
  ja_avaliado: 409,
}

const REVIEW_ERROR_MESSAGE: Record<string, string> = {
  pedido_nao_encontrado: 'Pedido não encontrado.',
  nao_autorizado: 'Você não pode avaliar este pedido.',
  pedido_nao_concluido: 'O pedido ainda não foi concluído.',
  ja_avaliado: 'Este pedido já foi avaliado.',
}

const loyaltyRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/loyalty',
    {
      onRequest: app.requireAuth,
      schema: {
        tags: ['fidelidade'],
        description: 'Saldo e extrato de pontos do cliente no estabelecimento.',
        querystring: Type.Object({ tenantSlug: Slug }),
        response: { 200: LoyaltyStatement, ...StandardErrors },
      },
    },
    async (request) => {
      const context = await resolveCustomerContext(
        request.supabase,
        request.query.tenantSlug,
        request.auth!.userId,
      )
      if (!context) return { balance: 0, transactions: [] }

      const [{ data: customer }, { data: rows }] = await Promise.all([
        request.supabase
          .from('customers')
          .select('loyalty_points')
          .eq('id', context.customerId)
          .maybeSingle(),
        request.supabase
          .from('loyalty_transactions')
          .select('id, type, points, cashback, description, created_at')
          .eq('customer_id', context.customerId)
          .order('created_at', { ascending: false })
          .limit(50),
      ])

      return {
        balance: Number(customer?.loyalty_points ?? 0),
        transactions: (rows ?? []).map((row: Record<string, unknown>) => ({
          id: String(row.id),
          type: row.type as never,
          points: Number(row.points),
          cashback: Number(row.cashback),
          description: (row.description as string | null) ?? null,
          createdAt: String(row.created_at),
        })),
      }
    },
  )

  app.post(
    '/orders/:id/review',
    {
      onRequest: app.requireAuth,
      schema: {
        tags: ['fidelidade'],
        description: 'Avaliação pós-entrega (1 a 5 estrelas) com comentário opcional.',
        params: Type.Object({ id: Uuid }),
        body: ReviewInput,
        response: { 201: ReviewResult, ...StandardErrors },
      },
    },
    async (request, reply) => {
      const { data, error } = await request.supabase.rpc('submit_order_review', {
        p_order_id: request.params.id,
        p_rating: request.body.rating,
        p_comment: request.body.comment ?? null,
      })

      if (error) throw app.httpErrors.internalServerError(error.message)

      const result = data as { ok: boolean; error: string | null; reviewId: string | null }
      if (!result.ok || !result.reviewId) {
        const code = result.error ?? 'desconhecido'
        throw app.httpErrors.createError(
          REVIEW_ERROR_STATUS[code] ?? 400,
          REVIEW_ERROR_MESSAGE[code] ?? 'Não foi possível registrar a avaliação.',
        )
      }

      return reply.status(201).send({ reviewId: result.reviewId })
    },
  )

  app.get(
    '/public/reputation',
    {
      schema: {
        tags: ['fidelidade'],
        description: 'Resumo público de reputação (NPS) e últimas avaliações.',
        querystring: Type.Object({ tenantSlug: Slug }),
        response: { 200: ReputationSummary, 404: ErrorResponse, 429: ErrorResponse },
      },
    },
    async (request) => {
      const { data: tenant } = await request.supabase
        .from('tenants')
        .select('id')
        .eq('slug', request.query.tenantSlug)
        .eq('is_active', true)
        .maybeSingle()

      if (!tenant) throw app.httpErrors.notFound('Estabelecimento não encontrado')

      const [{ data: nps }, { data: reviews }] = await Promise.all([
        request.supabase.rpc('tenant_nps', { p_tenant_id: tenant.id, p_since: null }),
        request.supabase
          .from('order_reviews')
          .select('id, rating, comment, created_at')
          .eq('tenant_id', tenant.id)
          .order('created_at', { ascending: false })
          .limit(20),
      ])

      const summary = (nps ?? {}) as Record<string, unknown>
      return {
        total: Number(summary.total ?? 0),
        average: Number(summary.average ?? 0),
        promoters: Number(summary.promoters ?? 0),
        neutrals: Number(summary.neutrals ?? 0),
        detractors: Number(summary.detractors ?? 0),
        nps: Number(summary.nps ?? 0),
        reviews: (reviews ?? []).map((row: Record<string, unknown>) => ({
          id: String(row.id),
          rating: Number(row.rating),
          comment: (row.comment as string | null) ?? null,
          createdAt: String(row.created_at),
        })),
      }
    },
  )
}

export default loyaltyRoutes
