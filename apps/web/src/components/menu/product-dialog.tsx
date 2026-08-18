'use client'

import { useEffect, useMemo, useState } from 'react'
import type { MenuProduct, OptionSelection } from '@vendas-bot/shared'
import { calculateUnitPrice, formatBRL, snapshotSelection, validateSelection } from '@vendas-bot/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useCart } from '@/lib/cart/cart-context'

export function ProductDialog({
  product,
  onClose,
}: {
  product: MenuProduct
  tenantSlug: string
  onClose: () => void
}) {
  const { addItem } = useCart()
  const [selection, setSelection] = useState<OptionSelection>({})
  const [quantity, setQuantity] = useState(1)
  const [notes, setNotes] = useState('')

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const errors = useMemo(() => validateSelection(product, selection), [product, selection])
  const unitPrice = useMemo(() => calculateUnitPrice(product, selection), [product, selection])

  function toggle(groupId: string, optionId: string, isSingle: boolean) {
    setSelection((current) => {
      const chosen = current[groupId] ?? []
      if (isSingle) return { ...current, [groupId]: chosen[0] === optionId ? [] : [optionId] }
      return {
        ...current,
        [groupId]: chosen.includes(optionId)
          ? chosen.filter((id) => id !== optionId)
          : [...chosen, optionId],
      }
    })
  }

  function handleAdd() {
    if (errors.length > 0) return
    addItem({
      productId: product.id,
      productName: product.name,
      unitPrice,
      quantity,
      notes: notes.trim() || null,
      selectedOptions: snapshotSelection(product, selection),
    })
    onClose()
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={product.name}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-6"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-border bg-background p-6 sm:rounded-2xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold">{product.name}</h2>
            {product.description ? (
              <p className="mt-1 text-sm text-muted-foreground">{product.description}</p>
            ) : null}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Fechar">
            ✕
          </Button>
        </div>

        {product.optionGroups.map((group) => {
          const isSingle = group.selectionType === 'single'
          const chosen = selection[group.id] ?? []
          return (
            <fieldset key={group.id} className="mb-5">
              <legend className="mb-2 flex w-full items-center justify-between gap-2 text-sm font-medium">
                {group.name}
                <span className="text-xs font-normal text-muted-foreground">
                  {group.minSelect > 0 ? 'Obrigatório' : 'Opcional'}
                  {group.maxSelect > 1 ? ` · até ${group.maxSelect}` : ''}
                </span>
              </legend>
              <ul className="flex flex-col gap-2">
                {group.options.map((option) => (
                  <li key={option.id}>
                    <label
                      className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm ${
                        option.isAvailable ? 'hover:bg-muted' : 'cursor-not-allowed opacity-50'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <input
                          type={isSingle ? 'radio' : 'checkbox'}
                          name={group.id}
                          checked={chosen.includes(option.id)}
                          disabled={!option.isAvailable}
                          onChange={() => toggle(group.id, option.id, isSingle)}
                        />
                        {option.name}
                      </span>
                      {option.priceDelta !== 0 ? (
                        <span className="text-muted-foreground">
                          {option.priceDelta > 0 ? '+' : ''}
                          {formatBRL(option.priceDelta)}
                        </span>
                      ) : null}
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          )
        })}

        <label className="mb-5 flex flex-col gap-1.5 text-sm font-medium">
          Observações
          <Input
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Ex.: sem cebola"
            maxLength={200}
          />
        </label>

        {errors.length > 0 ? (
          <ul role="alert" className="mb-4 flex flex-col gap-1 text-sm text-destructive">
            {errors.map((error) => (
              <li key={error.groupId}>{error.message}</li>
            ))}
          </ul>
        ) : null}

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 rounded-lg border border-border px-2">
            <Button variant="ghost" size="icon" aria-label="Diminuir" onClick={() => setQuantity((q) => Math.max(1, q - 1))}>
              −
            </Button>
            <span aria-live="polite" className="w-6 text-center text-sm font-medium">
              {quantity}
            </span>
            <Button variant="ghost" size="icon" aria-label="Aumentar" onClick={() => setQuantity((q) => Math.min(99, q + 1))}>
              +
            </Button>
          </div>
          <Button className="flex-1" onClick={handleAdd} disabled={errors.length > 0}>
            Adicionar · {formatBRL(unitPrice * quantity)}
          </Button>
        </div>
      </div>
    </div>
  )
}
