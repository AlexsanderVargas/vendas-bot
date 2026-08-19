'use client'

import { useCallback, useEffect, useState } from 'react'
import { formatBRL } from '@vendas-bot/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { apiFetch, ApiError } from '@/lib/api'

interface RecipeLine {
  id: string
  ingredientId: string
  ingredientName: string
  baseUnit: string
  quantity: number
  wastePercent: number
  effectiveQuantity: number
  unitCost: number
  lineCost: number
}

interface Recipe {
  productId: string
  productName: string
  price: number
  cmv: number
  margin: number
  marginPercent: number
  hasRecipe: boolean
  lines: RecipeLine[]
}

interface Option {
  id: string
  name: string
  baseUnit?: string
}

export function RecipeManager({ products, ingredients }: { products: Option[]; ingredients: Option[] }) {
  const [productId, setProductId] = useState(products[0]?.id ?? '')
  const [recipe, setRecipe] = useState<Recipe | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!productId) return
    setError(null)
    try {
      setRecipe(await apiFetch<Recipe>(`/products/${productId}/recipe`))
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível carregar a ficha técnica.')
    }
  }, [productId])

  useEffect(() => {
    void load()
  }, [load])

  async function addLine(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // O elemento precisa ser capturado ANTES do await: o React anula
    // event.currentTarget quando o handler síncrono termina, e chamar
    // .reset() depois lançaria TypeError — exibindo erro de falha em um
    // salvamento que deu certo.
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    setError(null)
    try {
      await apiFetch(`/products/${productId}/recipe`, {
        method: 'POST',
        body: JSON.stringify({
          ingredientId: String(form.get('ingredientId')),
          quantity: Number(form.get('quantity')),
          wastePercent: Number(form.get('wastePercent') || 0),
        }),
      })
      formElement.reset()
      await load()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível adicionar o insumo.')
    }
  }

  async function removeLine(lineId: string) {
    await apiFetch(`/products/${productId}/recipe/${lineId}`, { method: 'DELETE' })
    await load()
  }

  return (
    <section className="flex flex-col gap-6">
      <label className="flex max-w-sm flex-col gap-1.5 text-sm font-medium">
        Produto
        <select
          value={productId}
          onChange={(event) => setProductId(event.target.value)}
          className="h-10 rounded-lg border border-border bg-transparent px-3 text-sm"
        >
          {products.map((product) => (
            <option key={product.id} value={product.id}>
              {product.name}
            </option>
          ))}
        </select>
      </label>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {recipe ? (
        <>
          <dl className="grid gap-4 sm:grid-cols-4">
            <div className="rounded-xl border border-border p-4">
              <dt className="text-xs text-muted-foreground">Preço de venda</dt>
              <dd className="text-lg font-semibold">{formatBRL(recipe.price)}</dd>
            </div>
            <div className="rounded-xl border border-border p-4">
              <dt className="text-xs text-muted-foreground">CMV</dt>
              <dd className="text-lg font-semibold">{formatBRL(recipe.cmv)}</dd>
            </div>
            <div className="rounded-xl border border-border p-4">
              <dt className="text-xs text-muted-foreground">Margem</dt>
              <dd className="text-lg font-semibold">{formatBRL(recipe.margin)}</dd>
            </div>
            <div className="rounded-xl border border-border p-4">
              <dt className="text-xs text-muted-foreground">Margem %</dt>
              <dd className="text-lg font-semibold">{recipe.marginPercent.toFixed(2)}%</dd>
            </div>
          </dl>

          {!recipe.hasRecipe ? (
            <p className="text-sm text-muted-foreground">
              Este produto ainda não tem ficha técnica — o CMV aparece como zero até você cadastrá-la.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="py-2 pr-4 font-medium">Insumo</th>
                    <th className="py-2 pr-4 text-right font-medium">Quantidade</th>
                    <th className="py-2 pr-4 text-right font-medium">Perda</th>
                    <th className="py-2 pr-4 text-right font-medium">Consumo real</th>
                    <th className="py-2 pr-4 text-right font-medium">Custo</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {recipe.lines.map((line) => (
                    <tr key={line.id} className="border-b border-border/60">
                      <td className="py-2 pr-4">{line.ingredientName}</td>
                      <td className="py-2 pr-4 text-right">
                        {line.quantity} {line.baseUnit}
                      </td>
                      <td className="py-2 pr-4 text-right text-muted-foreground">{line.wastePercent}%</td>
                      <td className="py-2 pr-4 text-right">
                        {line.effectiveQuantity} {line.baseUnit}
                      </td>
                      <td className="py-2 pr-4 text-right">{formatBRL(line.lineCost)}</td>
                      <td className="py-2 text-right">
                        <Button variant="ghost" size="sm" onClick={() => void removeLine(line.id)}>
                          Remover
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}

      <form onSubmit={addLine} className="flex flex-col gap-3 rounded-xl border border-border p-4">
        <h2 className="font-medium">Adicionar insumo à ficha</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <select
            name="ingredientId"
            required
            className="h-10 rounded-lg border border-border bg-transparent px-3 text-sm"
          >
            {ingredients.map((ingredient) => (
              <option key={ingredient.id} value={ingredient.id}>
                {ingredient.name} ({ingredient.baseUnit})
              </option>
            ))}
          </select>
          <Input name="quantity" type="number" step="0.0001" min="0.0001" placeholder="Quantidade" required />
          <Input name="wastePercent" type="number" step="0.01" min="0" max="99.99" placeholder="Perda %" />
        </div>
        <Button type="submit" disabled={!productId}>
          Adicionar
        </Button>
      </form>
    </section>
  )
}
