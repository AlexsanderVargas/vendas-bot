'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { formatBRL } from '@vendas-bot/shared'
import { Button } from '@/components/ui/button'
import { useCart } from '@/lib/cart/cart-context'
import { apiFetch } from '@/lib/api'

interface Suggestion {
  id: string
  name: string
  description: string | null
  price: number
  imageUrl: string | null
}

/**
 * Barra fixa com o resumo do carrinho e sugestões de upsell.
 * As sugestões são recalculadas a cada mudança do carrinho, excluindo o que
 * já está nele.
 */
export function CartDrawer({
  tenantSlug,
  categoryIdsByProduct,
}: {
  tenantSlug: string
  categoryIdsByProduct: Record<string, string>
}) {
  const { items, subtotal, itemCount, updateQuantity, addItem } = useCart()
  const [open, setOpen] = useState(false)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])

  useEffect(() => {
    if (items.length === 0) {
      setSuggestions([])
      return
    }
    let cancelled = false
    const categoryIds = [
      ...new Set(
        items
          .map((item) => categoryIdsByProduct[item.productId])
          .filter((value): value is string => Boolean(value)),
      ),
    ]

    void apiFetch<Suggestion[]>('/public/suggestions', {
      method: 'POST',
      body: JSON.stringify({
        tenantSlug,
        categoryIds,
        excludeProductIds: [...new Set(items.map((item) => item.productId))],
        limit: 3,
      }),
    })
      .then((result) => {
        if (!cancelled) setSuggestions(result)
      })
      .catch(() => {
        if (!cancelled) setSuggestions([])
      })

    return () => {
      cancelled = true
    }
  }, [items, tenantSlug, categoryIdsByProduct])

  if (itemCount === 0) return null

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background">
      {open ? (
        <div className="mx-auto max-h-[60dvh] max-w-3xl overflow-y-auto px-4 py-4">
          <ul className="flex flex-col gap-3">
            {items.map((item) => (
              <li key={item.lineId} className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium">{item.productName}</p>
                  {item.selectedOptions.length > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {item.selectedOptions.map((option) => option.optionName).join(' · ')}
                    </p>
                  ) : null}
                  {item.notes ? (
                    <p className="text-xs text-muted-foreground">Obs.: {item.notes}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Diminuir ${item.productName}`}
                    onClick={() => updateQuantity(item.lineId, item.quantity - 1)}
                  >
                    −
                  </Button>
                  <span className="w-5 text-center text-sm">{item.quantity}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Aumentar ${item.productName}`}
                    onClick={() => updateQuantity(item.lineId, item.quantity + 1)}
                  >
                    +
                  </Button>
                  <span className="w-20 text-right text-sm font-medium">
                    {formatBRL(item.unitPrice * item.quantity)}
                  </span>
                </div>
              </li>
            ))}
          </ul>

          {suggestions.length > 0 ? (
            <div className="mt-6 border-t border-border pt-4">
              <p className="mb-3 text-sm font-medium">Que tal adicionar?</p>
              <ul className="flex gap-3 overflow-x-auto pb-1">
                {suggestions.map((suggestion) => (
                  <li key={suggestion.id} className="shrink-0">
                    <button
                      type="button"
                      onClick={() =>
                        addItem({
                          productId: suggestion.id,
                          productName: suggestion.name,
                          unitPrice: suggestion.price,
                          quantity: 1,
                          notes: null,
                          selectedOptions: [],
                        })
                      }
                      className="flex w-40 flex-col gap-1 rounded-xl border border-border p-3 text-left text-sm hover:bg-muted"
                    >
                      <span className="font-medium">{suggestion.name}</span>
                      <span className="text-muted-foreground">{formatBRL(suggestion.price)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
        <Button variant="ghost" onClick={() => setOpen((value) => !value)} className="shrink-0">
          {open ? 'Ocultar' : `${itemCount} ${itemCount === 1 ? 'item' : 'itens'}`}
        </Button>
        <span className="flex-1 text-sm text-muted-foreground">
          Subtotal <strong className="text-foreground">{formatBRL(subtotal)}</strong>
        </span>
        <Link
          href={`/${tenantSlug}/checkout`}
          className="inline-flex h-10 items-center justify-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700"
        >
          Finalizar
        </Link>
      </div>
    </div>
  )
}
