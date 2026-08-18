'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'
import { apiFetch, ApiError } from '@/lib/api'

type PrepStatus = 'pending' | 'preparing' | 'ready' | 'served' | 'canceled'

interface QueueItem {
  orderId: string
  orderNumber: number
  origin: 'own' | 'ifood' | 'ubereats'
  externalDisplayId: string | null
  channel: string
  tableLabel: string | null
  itemId: string
  productName: string
  quantity: number
  notes: string | null
  selectedOptions: Array<{ groupName: string; optionName: string }>
  prepStatus: PrepStatus
  waitingSeconds: number
}

const CHANNEL_LABEL: Record<string, string> = {
  delivery: 'Entrega',
  takeaway: 'Retirada',
  dine_in: 'Salão',
}

/** A cozinha precisa saber a origem: o prazo e o fluxo mudam por canal. */
const ORIGIN_LABEL: Record<QueueItem['origin'], string> = {
  own: '',
  ifood: 'iFood',
  ubereats: 'Uber Eats',
}

/** Espera longa vira alerta visual: acima de 15 min a cozinha precisa ver. */
function waitingStyle(seconds: number): string {
  if (seconds > 900) return 'border-destructive'
  if (seconds > 600) return 'border-amber-500'
  return 'border-border'
}

function formatWaiting(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  return minutes < 1 ? 'agora' : `${minutes} min`
}

export function KdsBoard() {
  const [items, setItems] = useState<QueueItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  const load = useCallback(async () => {
    try {
      setItems(await apiFetch<QueueItem[]>('/kds/queue'))
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível carregar a fila.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, tick])

  // Recarrega quando qualquer item muda, e a cada 30s para o cronômetro andar.
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel('kds')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items' }, () => {
        void load()
      })
      .subscribe()

    const timer = setInterval(() => setTick((value) => value + 1), 30_000)

    return () => {
      void supabase.removeChannel(channel)
      clearInterval(timer)
    }
  }, [load])

  async function advance(itemId: string, status: PrepStatus) {
    setError(null)
    try {
      await apiFetch(`/kds/items/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      })
      await load()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível atualizar o item.')
    }
  }

  const byOrder = items.reduce<Record<string, QueueItem[]>>((groups, item) => {
    const bucket = groups[item.orderId] ?? []
    bucket.push(item)
    groups[item.orderId] = bucket
    return groups
  }, {})

  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">Nenhum item na fila de preparo.</p>
  }

  return (
    <section className="flex flex-col gap-4">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Object.entries(byOrder).map(([orderId, orderItems]) => {
          const first = orderItems[0]!
          const oldest = Math.max(...orderItems.map((item) => item.waitingSeconds))
          return (
            <li key={orderId} className={`rounded-xl border-2 p-4 ${waitingStyle(oldest)}`}>
              <div className="mb-3 flex items-baseline justify-between">
                <span className="font-semibold">
                  nº {first.externalDisplayId ?? first.orderNumber}
                  {first.origin !== 'own' ? (
                    <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
                      {ORIGIN_LABEL[first.origin]}
                    </span>
                  ) : null}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {CHANNEL_LABEL[first.channel] ?? first.channel}
                    {first.tableLabel ? ` · ${first.tableLabel}` : ''}
                  </span>
                </span>
                <span className="text-sm text-muted-foreground">{formatWaiting(oldest)}</span>
              </div>

              <ul className="flex flex-col gap-3">
                {orderItems.map((item) => (
                  <li key={item.itemId} className="border-t border-border/60 pt-3 first:border-t-0 first:pt-0">
                    <p className="font-medium">
                      {item.quantity}× {item.productName}
                    </p>
                    {item.selectedOptions.length > 0 ? (
                      <p className="text-xs text-muted-foreground">
                        {item.selectedOptions.map((option) => option.optionName).join(' · ')}
                      </p>
                    ) : null}
                    {item.notes ? (
                      <p className="text-xs font-medium text-amber-700">Obs.: {item.notes}</p>
                    ) : null}
                    <div className="mt-2 flex gap-2">
                      {item.prepStatus === 'pending' ? (
                        <Button size="sm" onClick={() => void advance(item.itemId, 'preparing')}>
                          Iniciar
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void advance(item.itemId, 'ready')}
                      >
                        Pronto
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
