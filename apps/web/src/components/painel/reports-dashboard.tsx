'use client'

import { useCallback, useEffect, useState } from 'react'
import { formatBRL } from '@vendas-bot/shared'
import { Input } from '@/components/ui/input'
import { apiFetch, ApiError } from '@/lib/api'

interface Dre {
  revenue: number
  deliveryRevenue: number
  discounts: number
  cmv: number
  grossProfit: number
  grossMarginPercent: number
  fixedExpenses: number
  variableExpenses: number
  netProfit: number
  netMarginPercent: number
  orderCount: number
  averageTicket: number
}

interface CashFlowDay {
  day: string
  inflow: number
  outflow: number
  net: number
  runningBalance: number
}

interface Projection {
  dailyRevenue: number
  dailyNetProfit: number
  horizonDays: number
  projectedRevenue: number
  projectedNetProfit: number
  confidence: 'low' | 'medium' | 'high'
}

interface TopProduct {
  productId: string | null
  productName: string
  quantity: number
  revenue: number
  orderCount: number
}

const CONFIDENCE_LABEL: Record<Projection['confidence'], string> = {
  low: 'baixa — histórico curto ou sem vendas',
  medium: 'média',
  high: 'alta',
}

function isoDaysAgo(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return date.toISOString().slice(0, 10)
}

export function ReportsDashboard() {
  const [from, setFrom] = useState(isoDaysAgo(30))
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10))
  const [dre, setDre] = useState<Dre | null>(null)
  const [cashFlow, setCashFlow] = useState<CashFlowDay[]>([])
  const [projection, setProjection] = useState<Projection | null>(null)
  const [topProducts, setTopProducts] = useState<TopProduct[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    const period = `from=${from}&to=${to}`
    try {
      const [dreData, flowData, projectionData, productsData] = await Promise.all([
        apiFetch<Dre>(`/reports/dre?${period}`),
        apiFetch<CashFlowDay[]>(`/reports/cash-flow?${period}`),
        apiFetch<Projection>('/reports/projection?lookbackDays=30&horizonDays=30'),
        apiFetch<TopProduct[]>(`/reports/top-products?${period}&limit=10`),
      ])
      setDre(dreData)
      setCashFlow(flowData)
      setProjection(projectionData)
      setTopProducts(productsData)
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível carregar os relatórios.')
    }
  }, [from, to])

  useEffect(() => {
    void load()
  }, [load])

  const maxFlow = Math.max(1, ...cashFlow.map((day) => Math.max(day.inflow, day.outflow)))

  return (
    <section className="flex flex-col gap-8">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          De
          <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Até
          <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </label>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {dre ? (
        <div>
          <h2 className="mb-3 text-lg font-semibold">DRE simplificado</h2>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-border p-4">
              <dt className="text-xs text-muted-foreground">Receita</dt>
              <dd className="text-lg font-semibold">{formatBRL(dre.revenue)}</dd>
            </div>
            <div className="rounded-xl border border-border p-4">
              <dt className="text-xs text-muted-foreground">CMV</dt>
              <dd className="text-lg font-semibold">{formatBRL(dre.cmv)}</dd>
            </div>
            <div className="rounded-xl border border-border p-4">
              <dt className="text-xs text-muted-foreground">Lucro bruto</dt>
              <dd className="text-lg font-semibold">
                {formatBRL(dre.grossProfit)}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {dre.grossMarginPercent.toFixed(1)}%
                </span>
              </dd>
            </div>
            <div
              className={`rounded-xl border-2 p-4 ${dre.netProfit < 0 ? 'border-destructive' : 'border-brand-600'}`}
            >
              <dt className="text-xs text-muted-foreground">Lucro líquido</dt>
              <dd className="text-lg font-semibold">
                {formatBRL(dre.netProfit)}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {dre.netMarginPercent.toFixed(1)}%
                </span>
              </dd>
            </div>
          </dl>

          <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4 text-sm">
            <div className="rounded-lg border border-border p-3">
              <dt className="text-xs text-muted-foreground">Pedidos</dt>
              <dd className="font-medium">{dre.orderCount}</dd>
            </div>
            <div className="rounded-lg border border-border p-3">
              <dt className="text-xs text-muted-foreground">Ticket médio</dt>
              <dd className="font-medium">{formatBRL(dre.averageTicket)}</dd>
            </div>
            <div className="rounded-lg border border-border p-3">
              <dt className="text-xs text-muted-foreground">Despesas fixas</dt>
              <dd className="font-medium">{formatBRL(dre.fixedExpenses)}</dd>
            </div>
            <div className="rounded-lg border border-border p-3">
              <dt className="text-xs text-muted-foreground">Despesas variáveis</dt>
              <dd className="font-medium">{formatBRL(dre.variableExpenses)}</dd>
            </div>
          </dl>
        </div>
      ) : null}

      {projection ? (
        <div>
          <h2 className="mb-3 text-lg font-semibold">Projeção para {projection.horizonDays} dias</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-border p-4">
              <p className="text-xs text-muted-foreground">Receita projetada</p>
              <p className="text-lg font-semibold">{formatBRL(projection.projectedRevenue)}</p>
              <p className="text-xs text-muted-foreground">
                {formatBRL(projection.dailyRevenue)} por dia
              </p>
            </div>
            <div className="rounded-xl border border-border p-4">
              <p className="text-xs text-muted-foreground">Lucro projetado</p>
              <p className="text-lg font-semibold">{formatBRL(projection.projectedNetProfit)}</p>
              <p className="text-xs text-muted-foreground">
                Confiança {CONFIDENCE_LABEL[projection.confidence]}
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {cashFlow.length > 0 ? (
        <div>
          <h2 className="mb-3 text-lg font-semibold">Fluxo de caixa</h2>
          <ul className="flex flex-col gap-1">
            {cashFlow.map((day) => (
              <li key={day.day} className="flex items-center gap-3 text-xs">
                <span className="w-20 shrink-0 text-muted-foreground">
                  {new Date(`${day.day}T12:00:00`).toLocaleDateString('pt-BR', {
                    day: '2-digit',
                    month: '2-digit',
                  })}
                </span>
                <span className="flex h-4 flex-1 items-center gap-0.5" aria-hidden>
                  <span
                    className="h-3 rounded-sm bg-brand-500"
                    style={{ width: `${(day.inflow / maxFlow) * 50}%` }}
                  />
                  <span
                    className="h-3 rounded-sm bg-destructive/60"
                    style={{ width: `${(day.outflow / maxFlow) * 50}%` }}
                  />
                </span>
                <span className="w-24 shrink-0 text-right">{formatBRL(day.net)}</span>
                <span className="w-24 shrink-0 text-right text-muted-foreground">
                  {formatBRL(day.runningBalance)}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            Barras: entradas (marca) e saídas (vermelho). Colunas: resultado do dia e saldo acumulado.
          </p>
        </div>
      ) : null}

      {topProducts.length > 0 ? (
        <div>
          <h2 className="mb-3 text-lg font-semibold">Mais vendidos</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="py-2 pr-4 font-medium">Produto</th>
                <th className="py-2 pr-4 text-right font-medium">Qtde</th>
                <th className="py-2 pr-4 text-right font-medium">Pedidos</th>
                <th className="py-2 text-right font-medium">Receita</th>
              </tr>
            </thead>
            <tbody>
              {topProducts.map((product) => (
                <tr key={product.productId ?? product.productName} className="border-b border-border/60">
                  <td className="py-2 pr-4">{product.productName}</td>
                  <td className="py-2 pr-4 text-right">{product.quantity}</td>
                  <td className="py-2 pr-4 text-right">{product.orderCount}</td>
                  <td className="py-2 text-right">{formatBRL(product.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  )
}
