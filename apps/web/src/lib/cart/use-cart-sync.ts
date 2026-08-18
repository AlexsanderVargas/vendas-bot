'use client'

import { useEffect, useRef } from 'react'
import { apiFetch } from '@/lib/api'
import type { CartItem } from './types'

/**
 * Sincroniza o carrinho local com o banco quando há sessão, com debounce.
 * Falhas são silenciosas de propósito: o localStorage continua sendo a fonte
 * da verdade durante a navegação; a cópia no banco serve a reengajamento.
 */
export function useCartSync(tenantSlug: string, items: CartItem[], enabled: boolean): void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!enabled) return
    if (timer.current) clearTimeout(timer.current)

    timer.current = setTimeout(() => {
      void apiFetch('/cart', {
        method: 'PUT',
        body: JSON.stringify({
          tenantSlug,
          items: items.map((item) => ({
            lineKey: item.lineId,
            productId: item.productId,
            quantity: item.quantity,
            notes: item.notes,
            selectedOptions: item.selectedOptions,
          })),
        }),
      }).catch(() => undefined)
    }, 1200)

    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [tenantSlug, items, enabled])
}
