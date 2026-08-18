import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import { Money, StandardErrors, Uuid } from '@vendas-bot/shared'

const DirectionSchema = Type.Union([Type.Literal('payable'), Type.Literal('receivable')])
const StatusSchema = Type.Union([
  Type.Literal('open'),
  Type.Literal('partially_paid'),
  Type.Literal('paid'),
  Type.Literal('overdue'),
  Type.Literal('canceled'),
])

/** Contrato de saída de um título financeiro. */
const Account = Type.Object({
  id: Uuid,
  direction: DirectionSchema,
  status: StatusSchema,
  description: Type.String(),
  amount: Money,
  paidAmount: Type.Number(),
  remaining: Type.Number(),
  dueDate: Type.String(),
  paidAt: Type.Union([Type.String(), Type.Null()]),
  installment: Type.Integer(),
  installments: Type.Integer(),
  supplierId: Type.Union([Uuid, Type.Null()]),
  categoryId: Type.Union([Uuid, Type.Null()]),
})

const Category = Type.Object({
  id: Uuid,
  name: Type.String(),
  isFixed: Type.Boolean(),
})

const ACCOUNT_COLUMNS =
  'id, direction, status, description, amount, paid_amount, due_date, paid_at, installment, installments, supplier_id, category_id'

const FINANCE_ERROR: Record<string, { status: number; message: string }> = {
  nao_autorizado: { status: 403, message: 'Este título pertence a outro estabelecimento.' },
  conta_nao_encontrada: { status: 404, message: 'Título não encontrado.' },
  conta_cancelada: { status: 409, message: 'Título cancelado não aceita baixa.' },
  valor_invalido: { status: 400, message: 'Valor de baixa inválido para o saldo devedor.' },
  parcelas_invalidas: { status: 400, message: 'Informe um total positivo e ao menos uma parcela.' },
}

/** Contrato: (error) -> { status, message } */
export function mapFinanceError(error: string): { status: number; message: string } {
  return FINANCE_ERROR[error] ?? { status: 400, message: 'Não foi possível concluir a operação.' }
}

interface AccountRow {
  id: string
  direction: 'payable' | 'receivable'
  status: 'open' | 'partially_paid' | 'paid' | 'overdue' | 'canceled'
  description: string
  amount: string | number
  paid_amount: string | number
  due_date: string
  paid_at: string | null
  installment: number
  installments: number
  supplier_id: string | null
  category_id: string | null
}

/** Contrato: (row) -> Account — normaliza numéricos e deriva o saldo. */
export function toAccount(row: AccountRow) {
  const amount = Number(row.amount)
  const paidAmount = Number(row.paid_amount)
  return {
    id: row.id,
    direction: row.direction,
    status: row.status,
    description: row.description,
    amount,
    paidAmount,
    remaining: Math.round((amount - paidAmount) * 100) / 100,
    dueDate: row.due_date,
    paidAt: row.paid_at,
    installment: row.installment,
    installments: row.installments,
    supplierId: row.supplier_id,
    categoryId: row.category_id,
  }
}

const financeRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/finance/accounts',
    {
      onRequest: app.requirePermission('finance.read'),
      schema: {
        tags: ['financeiro'],
        description: 'Títulos a pagar e a receber.',
        querystring: Type.Object({
          direction: Type.Optional(DirectionSchema),
          status: Type.Optional(StatusSchema),
        }),
        response: { 200: Type.Array(Account), ...StandardErrors },
      },
    },
    async (request) => {
      let query = request.supabase
        .from('financial_accounts')
        .select(ACCOUNT_COLUMNS)
        .order('due_date', { ascending: true })
        .limit(200)

      if (request.query.direction) query = query.eq('direction', request.query.direction)
      if (request.query.status) query = query.eq('status', request.query.status)

      const { data, error } = await query
      if (error) throw app.httpErrors.internalServerError(error.message)
      return (data ?? []).map(toAccount)
    },
  )

  app.post(
    '/finance/accounts',
    {
      onRequest: app.requirePermission('finance.write'),
      schema: {
        tags: ['financeiro'],
        description: 'Lança um título, dividindo em parcelas mensais quando pedido.',
        body: Type.Object({
          direction: DirectionSchema,
          description: Type.String({ minLength: 1, maxLength: 180 }),
          amount: Type.Number({ exclusiveMinimum: 0 }),
          installments: Type.Integer({ minimum: 1, maximum: 60, default: 1 }),
          firstDueDate: Type.String({ format: 'date' }),
          supplierId: Type.Optional(Type.Union([Uuid, Type.Null()])),
          categoryId: Type.Optional(Type.Union([Uuid, Type.Null()])),
        }),
        response: {
          201: Type.Object({ groupId: Uuid, created: Type.Integer() }),
          ...StandardErrors,
        },
      },
    },
    async (request, reply) => {
      const { data, error } = await request.supabase.rpc('create_installments', {
        p_direction: request.body.direction,
        p_description: request.body.description,
        p_total: request.body.amount,
        p_installments: request.body.installments,
        p_first_due: request.body.firstDueDate,
        p_supplier_id: request.body.supplierId ?? null,
        p_category_id: request.body.categoryId ?? null,
      })
      if (error) throw app.httpErrors.internalServerError(error.message)

      const result = data as { ok: boolean; error: string | null; groupId: string | null; created: number }
      if (!result.ok || !result.groupId) {
        const mapped = mapFinanceError(result.error ?? 'desconhecido')
        throw app.httpErrors.createError(mapped.status, mapped.message)
      }
      return reply.status(201).send({ groupId: result.groupId, created: result.created })
    },
  )

  app.post(
    '/finance/accounts/:id/settle',
    {
      onRequest: app.requirePermission('finance.write'),
      schema: {
        tags: ['financeiro'],
        description: 'Baixa total ou parcial de um título, opcionalmente pelo caixa aberto.',
        params: Type.Object({ id: Uuid }),
        body: Type.Object({
          amount: Type.Number({ exclusiveMinimum: 0 }),
          cashSessionId: Type.Optional(Type.Union([Uuid, Type.Null()])),
        }),
        response: {
          200: Type.Object({
            status: StatusSchema,
            paidAmount: Type.Number(),
            remaining: Type.Number(),
          }),
          ...StandardErrors,
        },
      },
    },
    async (request) => {
      const { data, error } = await request.supabase.rpc('settle_account', {
        p_account_id: request.params.id,
        p_amount: request.body.amount,
        p_session_id: request.body.cashSessionId ?? null,
      })
      if (error) throw app.httpErrors.internalServerError(error.message)

      const result = data as {
        ok: boolean
        error: string | null
        status: string | null
        paidAmount: number | null
        remaining: number | null
      }
      if (!result.ok) {
        const mapped = mapFinanceError(result.error ?? 'desconhecido')
        throw app.httpErrors.createError(mapped.status, mapped.message)
      }
      return {
        status: result.status as never,
        paidAmount: Number(result.paidAmount),
        remaining: Number(result.remaining),
      }
    },
  )

  app.get(
    '/finance/categories',
    {
      onRequest: app.requirePermission('finance.read'),
      schema: {
        tags: ['financeiro'],
        description: 'Categorias de despesa do plano de contas.',
        response: { 200: Type.Array(Category), ...StandardErrors },
      },
    },
    async (request) => {
      const { data, error } = await request.supabase
        .from('expense_categories')
        .select('id, name, is_fixed')
        .eq('is_active', true)
        .order('name', { ascending: true })

      if (error) throw app.httpErrors.internalServerError(error.message)
      return (data ?? []).map((row: Record<string, unknown>) => ({
        id: String(row.id),
        name: String(row.name),
        isFixed: Boolean(row.is_fixed),
      }))
    },
  )

  app.post(
    '/finance/categories',
    {
      onRequest: app.requirePermission('finance.write'),
      schema: {
        tags: ['financeiro'],
        description: 'Cria uma categoria de despesa.',
        body: Type.Object({
          name: Type.String({ minLength: 1, maxLength: 80 }),
          isFixed: Type.Optional(Type.Boolean()),
        }),
        response: { 201: Category, ...StandardErrors },
      },
    },
    async (request, reply) => {
      const tenantId = request.requireTenantId()
      const { data, error } = await request.supabase
        .from('expense_categories')
        .insert({
          tenant_id: tenantId,
          name: request.body.name,
          is_fixed: request.body.isFixed ?? true,
        })
        .select('id, name, is_fixed')
        .single()

      if (error) throw app.httpErrors.badRequest(error.message)
      return reply.status(201).send({ id: data.id, name: data.name, isFixed: data.is_fixed })
    },
  )
}

export default financeRoutes
