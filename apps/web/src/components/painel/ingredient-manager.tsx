'use client'

import { useCallback, useEffect, useState } from 'react'
import { formatBRL } from '@vendas-bot/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { apiFetch, ApiError } from '@/lib/api'

interface Ingredient {
  id: string
  name: string
  sku: string | null
  baseUnit: 'g' | 'kg' | 'ml' | 'l' | 'un'
  averageCost: number
  stockQuantity: number
  minimumStock: number
  isPerishable: boolean
  shelfLifeDays: number | null
  isActive: boolean
  belowMinimum: boolean
}

const UNIT_LABEL: Record<Ingredient['baseUnit'], string> = {
  g: 'grama', kg: 'quilo', ml: 'mililitro', l: 'litro', un: 'unidade',
}

export function IngredientManager() {
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [search, setSearch] = useState('')
  const [onlyCritical, setOnlyCritical] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const params = new URLSearchParams()
    if (search) params.set('search', search)
    if (onlyCritical) params.set('belowMinimum', 'true')
    try {
      setIngredients(await apiFetch<Ingredient[]>(`/ingredients?${params}`))
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível carregar os insumos.')
    } finally {
      setLoading(false)
    }
  }, [search, onlyCritical])

  useEffect(() => {
    void load()
  }, [load])

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // O elemento precisa ser capturado ANTES do await: o React anula
    // event.currentTarget quando o handler síncrono termina, e chamar
    // .reset() depois lançaria TypeError — exibindo erro de falha em um
    // salvamento que deu certo.
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const isPerishable = form.get('isPerishable') === 'on'
    setError(null)
    try {
      await apiFetch<Ingredient>('/ingredients', {
        method: 'POST',
        body: JSON.stringify({
          name: String(form.get('name')),
          sku: String(form.get('sku') || '') || null,
          baseUnit: String(form.get('baseUnit')),
          minimumStock: Number(form.get('minimumStock') || 0),
          isPerishable,
          shelfLifeDays: isPerishable ? Number(form.get('shelfLifeDays') || 0) || null : null,
        }),
      })
      formElement.reset()
      await load()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível salvar o insumo.')
    }
  }

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Buscar insumo"
          className="max-w-xs"
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={onlyCritical}
            onChange={(event) => setOnlyCritical(event.target.checked)}
          />
          Somente abaixo do mínimo
        </label>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : ingredients.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhum insumo encontrado.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="py-2 pr-4 font-medium">Insumo</th>
                <th className="py-2 pr-4 font-medium">Unidade</th>
                <th className="py-2 pr-4 text-right font-medium">Estoque</th>
                <th className="py-2 pr-4 text-right font-medium">Mínimo</th>
                <th className="py-2 text-right font-medium">Custo médio</th>
              </tr>
            </thead>
            <tbody>
              {ingredients.map((ingredient) => (
                <tr key={ingredient.id} className="border-b border-border/60">
                  <td className="py-2 pr-4">
                    {ingredient.name}
                    {ingredient.belowMinimum ? (
                      <span className="ml-2 rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive">
                        repor
                      </span>
                    ) : null}
                    {ingredient.isPerishable ? (
                      <span className="ml-2 text-xs text-muted-foreground">
                        perecível · {ingredient.shelfLifeDays}d
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-4 text-muted-foreground">{UNIT_LABEL[ingredient.baseUnit]}</td>
                  <td className="py-2 pr-4 text-right">{ingredient.stockQuantity}</td>
                  <td className="py-2 pr-4 text-right text-muted-foreground">{ingredient.minimumStock}</td>
                  <td className="py-2 text-right">{formatBRL(ingredient.averageCost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-xl border border-border p-4">
        <h2 className="font-medium">Novo insumo</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input name="name" placeholder="Nome" required />
          <Input name="sku" placeholder="SKU (opcional)" />
          <select
            name="baseUnit"
            required
            className="h-10 rounded-lg border border-border bg-transparent px-3 text-sm"
          >
            {(['g', 'kg', 'ml', 'l', 'un'] as const).map((unit) => (
              <option key={unit} value={unit}>
                {UNIT_LABEL[unit]}
              </option>
            ))}
          </select>
          <Input name="minimumStock" type="number" step="0.001" min="0" placeholder="Estoque mínimo" />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="isPerishable" /> Perecível
          </label>
          <Input name="shelfLifeDays" type="number" min="1" placeholder="Validade (dias)" />
        </div>
        <Button type="submit">Cadastrar insumo</Button>
      </form>
    </section>
  )
}
