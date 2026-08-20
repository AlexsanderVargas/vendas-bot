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
  sessao_invalida: {
    status: 409,
    message: 'Caixa inválido: use um caixa aberto deste estabelecimento.',
  },
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

/** Contrato de saída do DRE simplificado. */
const DreReport = Type.Object({
  revenue: Type.Number(),
  deliveryRevenue: Type.Number(),
  discounts: Type.Number(),
  cmv: Type.Number(),
  grossProfit: Type.Number(),
  grossMarginPercent: Type.Number(),
  fixedExpenses: Type.Number(),
  variableExpenses: Type.Number(),
  netProfit: Type.Number(),
  netMarginPercent: Type.Number(),
  orderCount: Type.Integer(),
  averageTicket: Type.Number(),
})

const CashFlowDay = Type.Object({
  day: Type.String(),
  inflow: Type.Number(),
  outflow: Type.Number(),
  net: Type.Number(),
  runningBalance: Type.Number(),
})

const Projection = Type.Object({
  basisDays: Type.Integer(),
  dailyRevenue: Type.Number(),
  dailyNetProfit: Type.Number(),
  horizonDays: Type.Integer(),
  projectedRevenue: Type.Number(),
  projectedNetProfit: Type.Number(),
  confidence: Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')]),
})

const TopProduct = Type.Object({
  productId: Type.Union([Uuid, Type.Null()]),
  productName: Type.String(),
  quantity: Type.Number(),
  revenue: Type.Number(),
  orderCount: Type.Integer(),
})

const PeriodQuery = Type.Object({
  from: Type.Optional(Type.String({ format: 'date' })),
  to: Type.Optional(Type.String({ format: 'date' })),
})

const financeRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/reports/dre',
    {
      onRequest: app.requirePermission('reports.read'),
      schema: {
        tags: ['relatórios'],
        description:
          'DRE simplificado do período. O CMV é histórico: vem dos lotes consumidos, não do custo atual.',
        querystring: PeriodQuery,
        response: { 200: DreReport, ...StandardErrors },
      },
    },
    async (request) => {
      const tenantId = request.requireTenantId()
      const { data, error } = await request.supabase.rpc('dre_report', {
        p_tenant_id: tenantId,
        p_from: request.query.from ?? null,
        p_to: request.query.to ?? null,
      })
      if (error) throw app.httpErrors.internalServerError(error.message)

      const report = (data ?? {}) as Record<string, unknown>
      return {
        revenue: Number(report.revenue ?? 0),
        deliveryRevenue: Number(report.deliveryRevenue ?? 0),
        discounts: Number(report.discounts ?? 0),
        cmv: Number(report.cmv ?? 0),
        grossProfit: Number(report.grossProfit ?? 0),
        grossMarginPercent: Number(report.grossMarginPercent ?? 0),
        fixedExpenses: Number(report.fixedExpenses ?? 0),
        variableExpenses: Number(report.variableExpenses ?? 0),
        netProfit: Number(report.netProfit ?? 0),
        netMarginPercent: Number(report.netMarginPercent ?? 0),
        orderCount: Number(report.orderCount ?? 0),
        averageTicket: Number(report.averageTicket ?? 0),
      }
    },
  )

  app.get(
    '/reports/cash-flow',
    {
      onRequest: app.requirePermission('reports.read'),
      schema: {
        tags: ['relatórios'],
        description: 'Entradas e saídas de caixa por dia, com saldo acumulado.',
        querystring: PeriodQuery,
        response: { 200: Type.Array(CashFlowDay), ...StandardErrors },
      },
    },
    async (request) => {
      const tenantId = request.requireTenantId()
      const { data, error } = await request.supabase.rpc('cash_flow_report', {
        p_tenant_id: tenantId,
        p_from: request.query.from ?? null,
        p_to: request.query.to ?? null,
      })
      if (error) throw app.httpErrors.internalServerError(error.message)

      return (data ?? []).map((row: Record<string, unknown>) => ({
        day: String(row.day),
        inflow: Number(row.inflow),
        outflow: Number(row.outflow),
        net: Number(row.net),
        runningBalance: Number(row.running_balance),
      }))
    },
  )

  app.get(
    '/reports/projection',
    {
      onRequest: app.requirePermission('reports.read'),
      schema: {
        tags: ['relatórios'],
        description: 'Projeção linear de receita e lucro a partir da média diária observada.',
        querystring: Type.Object({
          lookbackDays: Type.Integer({ minimum: 1, maximum: 365, default: 30 }),
          horizonDays: Type.Integer({ minimum: 1, maximum: 365, default: 30 }),
        }),
        response: { 200: Projection, ...StandardErrors },
      },
    },
    async (request) => {
      const tenantId = request.requireTenantId()
      const { data, error } = await request.supabase.rpc('profit_projection', {
        p_tenant_id: tenantId,
        p_lookback_days: request.query.lookbackDays,
        p_horizon_days: request.query.horizonDays,
      })
      if (error) throw app.httpErrors.internalServerError(error.message)

      const projection = (data ?? {}) as Record<string, unknown>
      return {
        basisDays: Number(projection.basisDays ?? 0),
        dailyRevenue: Number(projection.dailyRevenue ?? 0),
        dailyNetProfit: Number(projection.dailyNetProfit ?? 0),
        horizonDays: Number(projection.horizonDays ?? 0),
        projectedRevenue: Number(projection.projectedRevenue ?? 0),
        projectedNetProfit: Number(projection.projectedNetProfit ?? 0),
        confidence: (projection.confidence ?? 'low') as never,
      }
    },
  )

  app.get(
    '/reports/top-products',
    {
      onRequest: app.requirePermission('reports.read'),
      schema: {
        tags: ['relatórios'],
        description: 'Produtos mais vendidos no período, por receita.',
        querystring: Type.Intersect([
          PeriodQuery,
          Type.Object({ limit: Type.Integer({ minimum: 1, maximum: 50, default: 10 }) }),
        ]),
        response: { 200: Type.Array(TopProduct), ...StandardErrors },
      },
    },
    async (request) => {
      const tenantId = request.requireTenantId()
      const { data, error } = await request.supabase.rpc('top_products_report', {
        p_tenant_id: tenantId,
        p_from: request.query.from ?? null,
        p_to: request.query.to ?? null,
        p_limit: request.query.limit,
      })
      if (error) throw app.httpErrors.internalServerError(error.message)

      return (data ?? []).map((row: Record<string, unknown>) => ({
        productId: (row.product_id as string | null) ?? null,
        productName: String(row.product_name),
        quantity: Number(row.quantity),
        revenue: Number(row.revenue),
        orderCount: Number(row.order_count),
      }))
    },
  )

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
