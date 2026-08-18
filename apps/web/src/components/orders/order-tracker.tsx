'use client'

import { useEffect, useState } from 'react'
import type { OrderStatus } from '@vendas-bot/shared'
import { formatBRL } from '@vendas-bot/shared'
import { createClient } from '@/lib/supabase/client'
import { apiFetch } from '@/lib/api'

interface TimelineEvent {
  id: string
  status: OrderStatus
  note: string | null
  createdAt: string
}

interface OrderView {
  id: string
  orderNumber: number
  status: OrderStatus
  channel: 'delivery' | 'takeaway' | 'dine_in'
  subtotal: number
  deliveryFee: number
  total: number
  items: Array<{ id: string; productName: string; quantity: number; total: number }>
}

const STATUS_LABEL: Record<OrderStatus, string> = {
  draft: 'Rascunho',
  placed: 'Pedido enviado',
  confirmed: 'Confirmado pelo restaurante',
  preparing: 'Em preparo',
  ready: 'Pronto',
  out_for_delivery: 'Saiu para entrega',
  delivered: 'Entregue',
  completed: 'Finalizado',
  canceled: 'Cancelado',
}

/** Etapas exibidas na barra de progresso, por canal. */
const FLOW: Record<'delivery' | 'takeaway' | 'dine_in', OrderStatus[]> = {
  delivery: ['placed', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered'],
  takeaway: ['placed', 'confirmed', 'preparing', 'ready', 'completed'],
  dine_in: ['placed', 'confirmed', 'preparing', 'ready', 'completed'],
}

/**
 * Acompanhamento em tempo real: a assinatura do Supabase Realtime recebe as
 * mudanças de status sem refresh. A RLS de order_status_events garante que só
 * chegam eventos dos pedidos do próprio cliente.
 */
export function OrderTracker({ order: initial }: { order: OrderView }) {
  const [order, setOrder] = useState(initial)
  const [events, setEvents] = useState<TimelineEvent[]>([])

  useEffect(() => {
    void apiFetch<TimelineEvent[]>(`/orders/${initial.id}/timeline`)
      .then(setEvents)
      .catch(() => setEvents([]))
  }, [initial.id])

  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel(`pedido-${initial.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'order_status_events',
          filter: `order_id=eq.${initial.id}`,
        },
        (payload) => {
          const row = payload.new as Record<string, unknown>
          const event: TimelineEvent = {
            id: String(row.id),
            status: row.status as OrderStatus,
            note: (row.note as string | null) ?? null,
            createdAt: String(row.created_at),
          }
          setEvents((current) =>
            current.some((existing) => existing.id === event.id) ? current : [...current, event],
          )
          setOrder((current) => ({ ...current, status: event.status }))
        },
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [initial.id])

  const steps = FLOW[order.channel]
  const currentIndex = steps.indexOf(order.status)
  const canceled = order.status === 'canceled'

  return (
    <div className="flex flex-col gap-8 py-8">
      <header>
        <p className="text-sm text-muted-foreground">Pedido nº {order.orderNumber}</p>
        <h2 className="text-2xl font-bold tracking-tight">{STATUS_LABEL[order.status]}</h2>
      </header>

      {canceled ? (
        <p className="rounded-xl border border-destructive/40 p-4 text-sm text-destructive">
          Este pedido foi cancelado.
        </p>
      ) : (
        <ol className="flex flex-col gap-3" aria-label="Progresso do pedido">
          {steps.map((step, index) => {
            const done = currentIndex >= index
            return (
              <li key={step} className="flex items-center gap-3">
                <span
                  aria-hidden
                  className={`h-3 w-3 shrink-0 rounded-full ${done ? 'bg-brand-600' : 'bg-border'}`}
                />
                <span className={done ? 'font-medium' : 'text-muted-foreground'}>
                  {STATUS_LABEL[step]}
                </span>
              </li>
            )
          })}
        </ol>
      )}

      <section>
        <h3 className="mb-3 font-semibold">Itens</h3>
        <ul className="flex flex-col gap-2 text-sm">
          {order.items.map((item) => (
            <li key={item.id} className="flex justify-between">
              <span>
                {item.quantity}× {item.productName}
              </span>
              <span>{formatBRL(item.total)}</span>
            </li>
          ))}
        </ul>
        <dl className="mt-4 flex flex-col gap-1 border-t border-border pt-4 text-sm">
          <div className="flex justify-between">
            <dt>Subtotal</dt>
            <dd>{formatBRL(order.subtotal)}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Entrega</dt>
            <dd>{formatBRL(order.deliveryFee)}</dd>
          </div>
          <div className="flex justify-between font-semibold">
            <dt>Total</dt>
            <dd>{formatBRL(order.total)}</dd>
          </div>
        </dl>
      </section>

      {events.length > 0 ? (
        <section>
          <h3 className="mb-3 font-semibold">Histórico</h3>
          <ul className="flex flex-col gap-2 text-sm text-muted-foreground">
            {events.map((event) => (
              <li key={event.id}>
                {new Date(event.createdAt).toLocaleString('pt-BR')} — {STATUS_LABEL[event.status]}
                {event.note ? ` (${event.note})` : ''}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
