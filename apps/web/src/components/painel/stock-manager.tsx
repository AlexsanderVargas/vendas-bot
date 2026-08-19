'use client'

import { useCallback, useEffect, useState } from 'react'
import { formatBRL } from '@vendas-bot/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { apiFetch, ApiError } from '@/lib/api'

interface Ingredient {
  id: string
  name: string
  baseUnit: string
  stockQuantity: number
  minimumStock: number
  averageCost: number
  isPerishable: boolean
  belowMinimum: boolean
}

interface Movement {
  id: string
  type: 'in' | 'out' | 'loss' | 'adjust'
  quantity: number
  unitCost: number
  reason: string | null
  createdAt: string
}

const MOVEMENT_LABEL: Record<Movement['type'], string> = {
  in: 'Entrada', out: 'Saída', loss: 'Perda', adjust: 'Ajuste',
}

export function StockManager({ suppliers }: { suppliers: Array<{ id: string; name: string }> }) {
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [selected, setSelected] = useState<string>('')
  const [movements, setMovements] = useState<Movement[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadIngredients = useCallback(async () => {
    try {
      const list = await apiFetch<Ingredient[]>('/ingredients')
      setIngredients(list)
      setSelected((current) => current || list[0]?.id || '')
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível carregar os insumos.')
    }
  }, [])

  const loadMovements = useCallback(async () => {
    if (!selected) return
    try {
      setMovements(await apiFetch<Movement[]>(`/ingredients/${selected}/movements`))
    } catch {
      setMovements([])
    }
  }, [selected])

  useEffect(() => {
    void loadIngredients()
  }, [loadIngredients])

  useEffect(() => {
    void loadMovements()
  }, [loadMovements])

  const current = ingredients.find((ingredient) => ingredient.id === selected)

  async function receive(event: React.FormEvent<HTMLFormElement>) {
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
      const result = await apiFetch<{ stockQuantity: number; averageCost: number }>(
        `/ingredients/${selected}/receive`,
        {
          method: 'POST',
          body: JSON.stringify({
            quantity: Number(form.get('quantity')),
            unitCost: Number(form.get('unitCost')),
            expiresAt: String(form.get('expiresAt') || '') || null,
            supplierId: String(form.get('supplierId') || '') || null,
            batchCode: String(form.get('batchCode') || '') || null,
          }),
        },
      )
      setMessage(
        `Entrada registrada. Saldo: ${result.stockQuantity} · custo médio ${formatBRL(result.averageCost)}`,
      )
      formElement.reset()
      await Promise.all([loadIngredients(), loadMovements()])
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível registrar a entrada.')
    }
  }

  async function consume(event: React.FormEvent<HTMLFormElement>) {
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
      const result = await apiFetch<{ consumed: number; shortage: boolean }>(
        `/ingredients/${selected}/consume`,
        {
          method: 'POST',
          body: JSON.stringify({
            quantity: Number(form.get('quantity')),
            type: String(form.get('type')),
            reason: String(form.get('reason') || '') || null,
          }),
        },
      )
      setMessage(
        result.shortage
          ? `Baixado apenas ${result.consumed}: estoque insuficiente.`
          : `Baixa de ${result.consumed} registrada.`,
      )
      formElement.reset()
      await Promise.all([loadIngredients(), loadMovements()])
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível registrar a baixa.')
    }
  }

  return (
    <section className="flex flex-col gap-6">
      <label className="flex max-w-sm flex-col gap-1.5 text-sm font-medium">
        Insumo
        <select
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          className="h-10 rounded-lg border border-border bg-transparent px-3 text-sm"
        >
          {ingredients.map((ingredient) => (
            <option key={ingredient.id} value={ingredient.id}>
              {ingredient.name} — {ingredient.stockQuantity} {ingredient.baseUnit}
            </option>
          ))}
        </select>
      </label>

      {current ? (
        <dl className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-border p-4">
            <dt className="text-xs text-muted-foreground">Saldo</dt>
            <dd className="text-lg font-semibold">
              {current.stockQuantity} {current.baseUnit}
              {current.belowMinimum ? (
                <span className="ml-2 text-xs text-destructive">abaixo do mínimo</span>
              ) : null}
            </dd>
          </div>
          <div className="rounded-xl border border-border p-4">
            <dt className="text-xs text-muted-foreground">Custo médio</dt>
            <dd className="text-lg font-semibold">{formatBRL(current.averageCost)}</dd>
          </div>
          <div className="rounded-xl border border-border p-4">
            <dt className="text-xs text-muted-foreground">Mínimo</dt>
            <dd className="text-lg font-semibold">
              {current.minimumStock} {current.baseUnit}
            </dd>
          </div>
        </dl>
      ) : null}

      {message ? <p className="text-sm">{message}</p> : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <form onSubmit={receive} className="flex flex-col gap-3 rounded-xl border border-border p-4">
          <h2 className="font-medium">Entrada de mercadoria</h2>
          <Input name="quantity" type="number" step="0.001" min="0.001" placeholder="Quantidade" required />
          <Input name="unitCost" type="number" step="0.0001" min="0" placeholder="Custo por unidade base" required />
          <Input
            name="expiresAt"
            type="date"
            placeholder="Validade"
            required={current?.isPerishable}
          />
          <Input name="batchCode" placeholder="Código do lote (opcional)" />
          <select
            name="supplierId"
            className="h-10 rounded-lg border border-border bg-transparent px-3 text-sm"
          >
            <option value="">Sem fornecedor</option>
            {suppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name}
              </option>
            ))}
          </select>
          <Button type="submit" disabled={!selected}>
            Registrar entrada
          </Button>
        </form>

        <form onSubmit={consume} className="flex flex-col gap-3 rounded-xl border border-border p-4">
          <h2 className="font-medium">Baixa manual</h2>
          <p className="text-xs text-muted-foreground">
            O consumo segue FEFO: sai primeiro o lote que vence antes.
          </p>
          <Input name="quantity" type="number" step="0.001" min="0.001" placeholder="Quantidade" required />
          <select
            name="type"
            className="h-10 rounded-lg border border-border bg-transparent px-3 text-sm"
          >
            <option value="out">Saída (produção)</option>
            <option value="loss">Perda</option>
            <option value="adjust">Ajuste</option>
          </select>
          <Input name="reason" placeholder="Motivo" />
          <Button type="submit" disabled={!selected}>
            Registrar baixa
          </Button>
        </form>
      </div>

      <div>
        <h2 className="mb-3 font-medium">Movimentações</h2>
        {movements.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sem movimentações registradas.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {movements.map((movement) => (
              <li key={movement.id} className="flex justify-between gap-4 border-b border-border/60 py-1">
                <span>
                  {new Date(movement.createdAt).toLocaleString('pt-BR')} ·{' '}
                  {MOVEMENT_LABEL[movement.type]}
                  {movement.reason ? ` — ${movement.reason}` : ''}
                </span>
                <span className={movement.type === 'in' ? '' : 'text-muted-foreground'}>
                  {movement.type === 'in' ? '+' : '−'}
                  {movement.quantity}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
