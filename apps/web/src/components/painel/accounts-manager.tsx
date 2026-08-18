'use client'

import { useCallback, useEffect, useState } from 'react'
import { formatBRL } from '@vendas-bot/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { apiFetch, ApiError } from '@/lib/api'

interface Account {
  id: string
  direction: 'payable' | 'receivable'
  status: 'open' | 'partially_paid' | 'paid' | 'overdue' | 'canceled'
  description: string
  amount: number
  paidAmount: number
  remaining: number
  dueDate: string
  installment: number
  installments: number
}

interface Category {
  id: string
  name: string
  isFixed: boolean
}

const STATUS_LABEL: Record<Account['status'], string> = {
  open: 'Em aberto',
  partially_paid: 'Parcial',
  paid: 'Pago',
  overdue: 'Vencido',
  canceled: 'Cancelado',
}

export function AccountsManager() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [direction, setDirection] = useState<'payable' | 'receivable'>('payable')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [list, categoryList] = await Promise.all([
        apiFetch<Account[]>(`/finance/accounts?direction=${direction}`),
        apiFetch<Category[]>('/finance/categories'),
      ])
      setAccounts(list)
      setCategories(categoryList)
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível carregar o financeiro.')
    }
  }, [direction])

  useEffect(() => {
    void load()
  }, [load])

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setError(null)
    try {
      await apiFetch('/finance/accounts', {
        method: 'POST',
        body: JSON.stringify({
          direction,
          description: String(form.get('description')),
          amount: Number(form.get('amount')),
          installments: Number(form.get('installments') || 1),
          firstDueDate: String(form.get('firstDueDate')),
          categoryId: String(form.get('categoryId') || '') || null,
        }),
      })
      event.currentTarget.reset()
      await load()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível lançar o título.')
    }
  }

  async function settle(account: Account) {
    setError(null)
    try {
      await apiFetch(`/finance/accounts/${account.id}/settle`, {
        method: 'POST',
        body: JSON.stringify({ amount: account.remaining }),
      })
      await load()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível baixar o título.')
    }
  }

  const totalOpen = accounts
    .filter((account) => account.status !== 'paid' && account.status !== 'canceled')
    .reduce((sum, account) => sum + account.remaining, 0)

  return (
    <section className="flex flex-col gap-6">
      <div className="flex gap-2">
        {(['payable', 'receivable'] as const).map((option) => (
          <Button
            key={option}
            variant={direction === option ? 'default' : 'outline'}
            onClick={() => setDirection(option)}
          >
            {option === 'payable' ? 'A pagar' : 'A receber'}
          </Button>
        ))}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="rounded-xl border border-border p-4">
        <p className="text-xs text-muted-foreground">
          Saldo em aberto ({direction === 'payable' ? 'a pagar' : 'a receber'})
        </p>
        <p className="text-2xl font-semibold">{formatBRL(totalOpen)}</p>
      </div>

      {accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhum título lançado.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="py-2 pr-4 font-medium">Descrição</th>
                <th className="py-2 pr-4 font-medium">Vencimento</th>
                <th className="py-2 pr-4 text-right font-medium">Valor</th>
                <th className="py-2 pr-4 text-right font-medium">Saldo</th>
                <th className="py-2 pr-4 font-medium">Situação</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id} className="border-b border-border/60">
                  <td className="py-2 pr-4">{account.description}</td>
                  <td className="py-2 pr-4">
                    {new Date(`${account.dueDate}T12:00:00`).toLocaleDateString('pt-BR')}
                  </td>
                  <td className="py-2 pr-4 text-right">{formatBRL(account.amount)}</td>
                  <td className="py-2 pr-4 text-right">{formatBRL(account.remaining)}</td>
                  <td className={`py-2 pr-4 ${account.status === 'overdue' ? 'text-destructive' : ''}`}>
                    {STATUS_LABEL[account.status]}
                  </td>
                  <td className="py-2 text-right">
                    {account.status !== 'paid' && account.status !== 'canceled' ? (
                      <Button size="sm" variant="outline" onClick={() => void settle(account)}>
                        Baixar
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form onSubmit={create} className="flex flex-col gap-3 rounded-xl border border-border p-4">
        <h2 className="font-medium">
          Novo título {direction === 'payable' ? 'a pagar' : 'a receber'}
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input name="description" placeholder="Descrição" required className="sm:col-span-2" />
          <Input name="amount" type="number" step="0.01" min="0.01" placeholder="Valor total" required />
          <Input name="installments" type="number" min="1" max="60" placeholder="Parcelas" defaultValue={1} />
          <Input name="firstDueDate" type="date" required />
          <select
            name="categoryId"
            className="h-10 rounded-lg border border-border bg-transparent px-3 text-sm"
          >
            <option value="">Sem categoria</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name} ({category.isFixed ? 'fixa' : 'variável'})
              </option>
            ))}
          </select>
        </div>
        <Button type="submit">Lançar</Button>
      </form>
    </section>
  )
}
