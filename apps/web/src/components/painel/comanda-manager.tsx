'use client'

import { useCallback, useEffect, useState } from 'react'
import { formatBRL } from '@vendas-bot/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { apiFetch, ApiError } from '@/lib/api'

interface MenuOption {
  id: string
  name: string
  priceDelta: number
  isAvailable: boolean
}

interface MenuOptionGroup {
  id: string
  name: string
  selectionType: 'single' | 'multiple'
  minSelect: number
  maxSelect: number
  options: MenuOption[]
}

interface Product {
  id: string
  name: string
  price: number
  optionGroups: MenuOptionGroup[]
}

interface DiningTable {
  id: string
  label: string
  status: string
  sectorName: string | null
}

interface OrderItem {
  id: string
  productName: string
  quantity: number
  total: number
}

interface Order {
  id: string
  orderNumber: number
  total: number
  items: OrderItem[]
}

export function ComandaManager({ products }: { products: Product[] }) {
  const [tables, setTables] = useState<DiningTable[]>([])
  const [tableId, setTableId] = useState('')
  const [order, setOrder] = useState<Order | null>(null)
  const [productId, setProductId] = useState(products[0]?.id ?? '')
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string[]>>({})
  const [error, setError] = useState<string | null>(null)

  const product = products.find((candidate) => candidate.id === productId)

  const loadTables = useCallback(async () => {
    try {
      const list = await apiFetch<DiningTable[]>('/dining/tables')
      setTables(list)
      setTableId((current) => current || list[0]?.id || '')
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível carregar as mesas.')
    }
  }, [])

  useEffect(() => {
    void loadTables()
  }, [loadTables])

  async function openOrder() {
    setError(null)
    try {
      const opened = await apiFetch<{ orderId: string; orderNumber: number }>(
        `/dining/tables/${tableId}/order`,
        { method: 'POST', body: JSON.stringify({}) },
      )
      setOrder({ id: opened.orderId, orderNumber: opened.orderNumber, total: 0, items: [] })
      await loadTables()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível abrir a comanda.')
    }
  }

  async function refreshOrder(orderId: string) {
    const detail = await apiFetch<Order>(`/orders/${orderId}`)
    setOrder(detail)
  }

  async function addItem() {
    if (!order || !product) return
    setError(null)
    try {
      await apiFetch(`/orders/${order.id}/items`, {
        method: 'POST',
        body: JSON.stringify({
          productId: product.id,
          quantity: 1,
          optionIds: Object.values(selectedOptions).flat(),
        }),
      })
      setSelectedOptions({})
      await refreshOrder(order.id)
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível lançar o item.')
    }
  }

  async function closeOrder() {
    if (!order) return
    setError(null)
    try {
      await apiFetch(`/orders/${order.id}/close`, { method: 'POST' })
      setOrder(null)
      await loadTables()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível fechar a conta.')
    }
  }

  function toggleOption(group: MenuOptionGroup, optionId: string) {
    setSelectedOptions((current) => {
      const chosen = current[group.id] ?? []
      if (group.selectionType === 'single') {
        return { ...current, [group.id]: chosen[0] === optionId ? [] : [optionId] }
      }
      return {
        ...current,
        [group.id]: chosen.includes(optionId)
          ? chosen.filter((id) => id !== optionId)
          : [...chosen, optionId],
      }
    })
  }

  return (
    <section className="flex flex-col gap-6">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Mesa
          <select
            value={tableId}
            onChange={(event) => setTableId(event.target.value)}
            className="h-10 rounded-lg border border-border bg-transparent px-3 text-sm"
          >
            {tables.map((table) => (
              <option key={table.id} value={table.id}>
                {table.label}
                {table.sectorName ? ` · ${table.sectorName}` : ''} ({table.status})
              </option>
            ))}
          </select>
        </label>
        <Button onClick={() => void openOrder()} disabled={!tableId}>
          Abrir comanda
        </Button>
      </div>

      {order ? (
        <div className="flex flex-col gap-4 rounded-xl border border-border p-4">
          <div className="flex items-baseline justify-between">
            <h2 className="font-semibold">Comanda nº {order.orderNumber}</h2>
            <span className="text-lg font-semibold">{formatBRL(order.total)}</span>
          </div>

          <ul className="flex flex-col gap-1 text-sm">
            {order.items.map((item) => (
              <li key={item.id} className="flex justify-between">
                <span>
                  {item.quantity}× {item.productName}
                </span>
                <span>{formatBRL(item.total)}</span>
              </li>
            ))}
            {order.items.length === 0 ? (
              <li className="text-muted-foreground">Nenhum item lançado ainda.</li>
            ) : null}
          </ul>

          <div className="border-t border-border pt-4">
            <label className="mb-3 flex max-w-sm flex-col gap-1.5 text-sm font-medium">
              Produto
              <select
                value={productId}
                onChange={(event) => {
                  setProductId(event.target.value)
                  setSelectedOptions({})
                }}
                className="h-10 rounded-lg border border-border bg-transparent px-3 text-sm"
              >
                {products.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name} — {formatBRL(option.price)}
                  </option>
                ))}
              </select>
            </label>

            {product?.optionGroups.map((group) => (
              <fieldset key={group.id} className="mb-3">
                <legend className="mb-1 text-sm font-medium">
                  {group.name}
                  {group.minSelect > 0 ? ' (obrigatório)' : ''}
                </legend>
                <div className="flex flex-wrap gap-2">
                  {group.options.map((option) => (
                    <label key={option.id} className="flex items-center gap-1.5 text-sm">
                      <input
                        type={group.selectionType === 'single' ? 'radio' : 'checkbox'}
                        name={group.id}
                        checked={(selectedOptions[group.id] ?? []).includes(option.id)}
                        disabled={!option.isAvailable}
                        onChange={() => toggleOption(group, option.id)}
                      />
                      {option.name}
                      {option.priceDelta !== 0 ? ` (+${formatBRL(option.priceDelta)})` : ''}
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}

            <div className="flex gap-2">
              <Button onClick={() => void addItem()}>Lançar item</Button>
              <Button variant="outline" onClick={() => void closeOrder()}>
                Fechar conta
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
