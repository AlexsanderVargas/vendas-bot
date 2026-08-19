'use client'

import { useCallback, useEffect, useState } from 'react'
import { formatBRL } from '@vendas-bot/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { apiFetch, ApiError } from '@/lib/api'

interface Session {
  id: string
  status: 'open' | 'closed'
  openingAmount: number
  countedAmount: number | null
  expectedAmount: number | null
  difference: number | null
  openedAt: string
  closedAt: string | null
}

interface Summary {
  openingAmount: number
  sales: number
  supplies: number
  withdrawals: number
  refunds: number
  expectedCash: number
  byMethod: Record<string, number>
  movementCount: number
}

const METHOD_LABEL: Record<string, string> = {
  cash: 'Dinheiro',
  credit_card: 'Crédito',
  debit_card: 'Débito',
  pix: 'PIX',
  meal_voucher: 'Vale-refeição',
  online: 'On-line',
  other: 'Outros',
}

export function CashRegister() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const open = sessions.find((session) => session.status === 'open') ?? null

  const load = useCallback(async () => {
    try {
      const list = await apiFetch<Session[]>('/cash/sessions')
      setSessions(list)
      const current = list.find((session) => session.status === 'open')
      setSummary(current ? await apiFetch<Summary>(`/cash/sessions/${current.id}/summary`) : null)
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível carregar o caixa.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function openSession(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // O elemento precisa ser capturado ANTES do await: o React anula
    // event.currentTarget quando o handler síncrono termina, e chamar
    // .reset() depois lançaria TypeError — exibindo erro de falha em um
    // salvamento que deu certo.
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    setError(null)
    setMessage(null)
    try {
      await apiFetch('/cash/sessions', {
        method: 'POST',
        body: JSON.stringify({ openingAmount: Number(form.get('openingAmount') || 0) }),
      })
      await load()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível abrir o caixa.')
    }
  }

  async function addMovement(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!open) return
    // O elemento precisa ser capturado ANTES do await: o React anula
    // event.currentTarget quando o handler síncrono termina, e chamar
    // .reset() depois lançaria TypeError — exibindo erro de falha em um
    // salvamento que deu certo.
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    setError(null)
    try {
      await apiFetch(`/cash/sessions/${open.id}/movements`, {
        method: 'POST',
        body: JSON.stringify({
          type: String(form.get('type')),
          method: String(form.get('method')),
          amount: Number(form.get('amount')),
          reason: String(form.get('reason') || '') || null,
        }),
      })
      formElement.reset()
      await load()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível registrar o movimento.')
    }
  }

  async function closeSession(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!open) return
    // O elemento precisa ser capturado ANTES do await: o React anula
    // event.currentTarget quando o handler síncrono termina, e chamar
    // .reset() depois lançaria TypeError — exibindo erro de falha em um
    // salvamento que deu certo.
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    setError(null)
    try {
      const result = await apiFetch<{ expectedCash: number; countedAmount: number; difference: number }>(
        `/cash/sessions/${open.id}/close`,
        {
          method: 'POST',
          body: JSON.stringify({
            countedAmount: Number(form.get('countedAmount')),
            notes: String(form.get('notes') || '') || null,
          }),
        },
      )
      setMessage(
        result.difference === 0
          ? `Caixa fechado sem diferença (${formatBRL(result.countedAmount)}).`
          : result.difference > 0
            ? `Caixa fechado com sobra de ${formatBRL(result.difference)}.`
            : `Caixa fechado com falta de ${formatBRL(Math.abs(result.difference))}.`,
      )
      await load()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível fechar o caixa.')
    }
  }

  return (
    <section className="flex flex-col gap-6">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {message ? <p className="text-sm font-medium">{message}</p> : null}

      {!open ? (
        <form onSubmit={openSession} className="flex flex-col gap-3 rounded-xl border border-border p-4">
          <h2 className="font-medium">Abrir caixa</h2>
          <Input
            name="openingAmount"
            type="number"
            step="0.01"
            min="0"
            placeholder="Fundo de troco"
            defaultValue={0}
          />
          <Button type="submit">Abrir caixa</Button>
        </form>
      ) : (
        <>
          {summary ? (
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-xl border border-border p-4">
                <dt className="text-xs text-muted-foreground">Vendas do turno</dt>
                <dd className="text-lg font-semibold">{formatBRL(summary.sales)}</dd>
              </div>
              <div className="rounded-xl border border-border p-4">
                <dt className="text-xs text-muted-foreground">Sangrias</dt>
                <dd className="text-lg font-semibold">{formatBRL(summary.withdrawals)}</dd>
              </div>
              <div className="rounded-xl border border-border p-4">
                <dt className="text-xs text-muted-foreground">Suprimentos</dt>
                <dd className="text-lg font-semibold">{formatBRL(summary.supplies)}</dd>
              </div>
              <div className="rounded-xl border-2 border-brand-600 p-4">
                <dt className="text-xs text-muted-foreground">Esperado em gaveta</dt>
                <dd className="text-lg font-semibold">{formatBRL(summary.expectedCash)}</dd>
              </div>
            </dl>
          ) : null}

          {summary && Object.keys(summary.byMethod).length > 0 ? (
            <div>
              <h2 className="mb-2 font-medium">Vendas por forma de pagamento</h2>
              <ul className="flex flex-col gap-1 text-sm">
                {Object.entries(summary.byMethod).map(([method, total]) => (
                  <li key={method} className="flex justify-between border-b border-border/60 py-1">
                    <span>{METHOD_LABEL[method] ?? method}</span>
                    <span>{formatBRL(total)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="grid gap-4 md:grid-cols-2">
            <form onSubmit={addMovement} className="flex flex-col gap-3 rounded-xl border border-border p-4">
              <h2 className="font-medium">Movimentação</h2>
              <select name="type" className="h-10 rounded-lg border border-border bg-transparent px-3 text-sm">
                <option value="supply">Suprimento</option>
                <option value="withdrawal">Sangria</option>
                <option value="sale">Venda</option>
                <option value="refund">Devolução</option>
              </select>
              <select name="method" className="h-10 rounded-lg border border-border bg-transparent px-3 text-sm">
                {Object.entries(METHOD_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <Input name="amount" type="number" step="0.01" min="0.01" placeholder="Valor" required />
              <Input name="reason" placeholder="Motivo" />
              <Button type="submit">Registrar</Button>
            </form>

            <form onSubmit={closeSession} className="flex flex-col gap-3 rounded-xl border border-border p-4">
              <h2 className="font-medium">Fechar caixa</h2>
              <p className="text-xs text-muted-foreground">
                Conte o dinheiro da gaveta. Cartão e PIX não entram na conferência.
              </p>
              <Input
                name="countedAmount"
                type="number"
                step="0.01"
                min="0"
                placeholder="Dinheiro contado"
                required
              />
              <Input name="notes" placeholder="Observações" />
              <Button type="submit" variant="outline">
                Fechar caixa
              </Button>
            </form>
          </div>
        </>
      )}

      <div>
        <h2 className="mb-3 font-medium">Turnos recentes</h2>
        {sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum turno registrado.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {sessions.map((session) => (
              <li key={session.id} className="flex justify-between gap-4 border-b border-border/60 py-1">
                <span>
                  {new Date(session.openedAt).toLocaleString('pt-BR')}
                  {session.status === 'open' ? ' · aberto' : ''}
                </span>
                {session.difference !== null ? (
                  <span className={session.difference < 0 ? 'text-destructive' : ''}>
                    {session.difference === 0
                      ? 'sem diferença'
                      : session.difference > 0
                        ? `sobra ${formatBRL(session.difference)}`
                        : `falta ${formatBRL(Math.abs(session.difference))}`}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
