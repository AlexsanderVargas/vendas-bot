import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import { Money, StandardErrors, Uuid } from '@vendas-bot/shared'

export const PAYMENT_METHODS = [
  'cash',
  'credit_card',
  'debit_card',
  'pix',
  'meal_voucher',
  'online',
  'other',
] as const
const PaymentMethodSchema = Type.Union(PAYMENT_METHODS.map((method) => Type.Literal(method)))

const MOVEMENT_TYPES = ['supply', 'withdrawal', 'sale', 'refund'] as const
const MovementTypeSchema = Type.Union(MOVEMENT_TYPES.map((type) => Type.Literal(type)))

/** Contrato de saída do resumo de um turno de caixa. */
const SessionSummary = Type.Object({
  openingAmount: Money,
  sales: Money,
  supplies: Money,
  withdrawals: Money,
  refunds: Money,
  /** Só dinheiro: cartão e PIX não ficam na gaveta. */
  expectedCash: Type.Number(),
  byMethod: Type.Record(Type.String(), Type.Number()),
  movementCount: Type.Integer(),
})

const Session = Type.Object({
  id: Uuid,
  status: Type.Union([Type.Literal('open'), Type.Literal('closed')]),
  openingAmount: Money,
  countedAmount: Type.Union([Type.Number(), Type.Null()]),
  expectedAmount: Type.Union([Type.Number(), Type.Null()]),
  difference: Type.Union([Type.Number(), Type.Null()]),
  openedAt: Type.String(),
  closedAt: Type.Union([Type.String(), Type.Null()]),
})

const IdParams = Type.Object({ id: Uuid })

const CASH_ERROR: Record<string, { status: number; message: string }> = {
  nao_autorizado: { status: 403, message: 'Este caixa pertence a outro estabelecimento.' },
  sessao_ja_aberta: { status: 409, message: 'Você já tem um caixa aberto.' },
  sessao_nao_encontrada: { status: 404, message: 'Caixa não encontrado.' },
  sessao_ja_fechada: { status: 409, message: 'Este caixa já foi fechado.' },
}

/** Contrato: (error) -> { status, message } */
export function mapCashError(error: string): { status: number; message: string } {
  return CASH_ERROR[error] ?? { status: 400, message: 'Não foi possível concluir a operação de caixa.' }
}

const cashRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/cash/sessions',
    {
      onRequest: app.requirePermission('cash.open'),
      schema: {
        tags: ['caixa'],
        description: 'Abre um turno de caixa com o fundo de troco informado.',
        body: Type.Object({
          openingAmount: Type.Number({ minimum: 0, default: 0 }),
          notes: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
        }),
        response: { 201: Type.Object({ sessionId: Uuid }), ...StandardErrors },
      },
    },
    async (request, reply) => {
      const { data, error } = await request.supabase.rpc('open_cash_session', {
        p_opening_amount: request.body.openingAmount,
        p_notes: request.body.notes ?? null,
      })
      if (error) throw app.httpErrors.internalServerError(error.message)

      const result = data as { ok: boolean; error: string | null; sessionId: string | null }
      if (!result.ok || !result.sessionId) {
        const mapped = mapCashError(result.error ?? 'desconhecido')
        throw app.httpErrors.createError(mapped.status, mapped.message)
      }
      return reply.status(201).send({ sessionId: result.sessionId })
    },
  )

  app.get(
    '/cash/sessions',
    {
      onRequest: app.requirePermission('cash.read'),
      schema: {
        tags: ['caixa'],
        description: 'Turnos de caixa do estabelecimento.',
        response: { 200: Type.Array(Session), ...StandardErrors },
      },
    },
    async (request) => {
      const { data, error } = await request.supabase
        .from('cash_sessions')
        .select('id, status, opening_amount, counted_amount, expected_amount, difference, opened_at, closed_at')
        .order('opened_at', { ascending: false })
        .limit(30)

      if (error) throw app.httpErrors.internalServerError(error.message)
      return (data ?? []).map((row: Record<string, unknown>) => ({
        id: String(row.id),
        status: row.status as 'open' | 'closed',
        openingAmount: Number(row.opening_amount),
        countedAmount: row.counted_amount === null ? null : Number(row.counted_amount),
        expectedAmount: row.expected_amount === null ? null : Number(row.expected_amount),
        difference: row.difference === null ? null : Number(row.difference),
        openedAt: String(row.opened_at),
        closedAt: (row.closed_at as string | null) ?? null,
      }))
    },
  )

  app.get(
    '/cash/sessions/:id/summary',
    {
      onRequest: app.requirePermission('cash.read'),
      schema: {
        tags: ['caixa'],
        description: 'Resumo do turno: vendas por forma, sangrias e dinheiro esperado em gaveta.',
        params: IdParams,
        response: { 200: SessionSummary, ...StandardErrors },
      },
    },
    async (request) => {
      const { data, error } = await request.supabase.rpc('cash_session_summary', {
        p_session_id: request.params.id,
      })
      if (error) throw app.httpErrors.internalServerError(error.message)

      const summary = (data ?? {}) as Record<string, unknown>
      const byMethod = (summary.byMethod ?? {}) as Record<string, unknown>
      return {
        openingAmount: Number(summary.openingAmount ?? 0),
        sales: Number(summary.sales ?? 0),
        supplies: Number(summary.supplies ?? 0),
        withdrawals: Number(summary.withdrawals ?? 0),
        refunds: Number(summary.refunds ?? 0),
        expectedCash: Number(summary.expectedCash ?? 0),
        byMethod: Object.fromEntries(
          Object.entries(byMethod).map(([method, total]) => [method, Number(total)]),
        ),
        movementCount: Number(summary.movementCount ?? 0),
      }
    },
  )

  app.post(
    '/cash/sessions/:id/movements',
    {
      onRequest: app.requirePermission('cash.movement'),
      schema: {
        tags: ['caixa'],
        description: 'Registra suprimento, sangria, venda ou devolução no turno.',
        params: IdParams,
        body: Type.Object({
          type: MovementTypeSchema,
          method: PaymentMethodSchema,
          amount: Type.Number({ exclusiveMinimum: 0 }),
          orderId: Type.Optional(Type.Union([Uuid, Type.Null()])),
          reason: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
        }),
        response: { 201: Type.Object({ id: Uuid }), ...StandardErrors },
      },
    },
    async (request, reply) => {
      const tenantId = request.requireTenantId()
      const { data, error } = await request.supabase
        .from('cash_movements')
        .insert({
          tenant_id: tenantId,
          session_id: request.params.id,
          order_id: request.body.orderId ?? null,
          type: request.body.type,
          method: request.body.method,
          amount: request.body.amount,
          reason: request.body.reason ?? null,
          created_by: request.auth!.userId,
        })
        .select('id')
        .single()

      if (error) {
        throw app.httpErrors.conflict(
          error.message.includes('já fechado')
            ? 'Este caixa já foi fechado e não aceita novas movimentações.'
            : error.message,
        )
      }
      return reply.status(201).send({ id: data.id })
    },
  )

  app.post(
    '/cash/sessions/:id/close',
    {
      onRequest: app.requirePermission('cash.open'),
      schema: {
        tags: ['caixa'],
        description: 'Fecha o turno conferindo o dinheiro contado contra o esperado.',
        params: IdParams,
        body: Type.Object({
          countedAmount: Type.Number({ minimum: 0 }),
          notes: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
        }),
        response: {
          200: Type.Object({
            expectedCash: Type.Number(),
            countedAmount: Type.Number(),
            difference: Type.Number(),
          }),
          ...StandardErrors,
        },
      },
    },
    async (request) => {
      const { data, error } = await request.supabase.rpc('close_cash_session', {
        p_session_id: request.params.id,
        p_counted_amount: request.body.countedAmount,
        p_notes: request.body.notes ?? null,
      })
      if (error) throw app.httpErrors.internalServerError(error.message)

      const result = data as {
        ok: boolean
        error: string | null
        expectedCash: number | null
        countedAmount: number | null
        difference: number | null
      }
      if (!result.ok) {
        const mapped = mapCashError(result.error ?? 'desconhecido')
        throw app.httpErrors.createError(mapped.status, mapped.message)
      }
      return {
        expectedCash: Number(result.expectedCash),
        countedAmount: Number(result.countedAmount),
        difference: Number(result.difference),
      }
    },
  )
}

export default cashRoutes
