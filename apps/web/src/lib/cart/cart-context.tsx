'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { buildLineKey, round2 } from '@vendas-bot/shared'
import { createClient } from '@/lib/supabase/client'
import { useCartSync } from './use-cart-sync'
import { EMPTY_CART, type CartItem, type CartState } from './types'

const STORAGE_PREFIX = 'vendas-bot:cart:'

interface CartContextValue {
  items: CartItem[]
  subtotal: number
  itemCount: number
  addItem: (item: Omit<CartItem, 'lineId'>) => void
  updateQuantity: (lineId: string, quantity: number) => void
  removeItem: (lineId: string) => void
  clear: () => void
}

const CartContext = createContext<CartContextValue | null>(null)

/**
 * Carrinho persistido em localStorage por estabelecimento. A sincronização
 * com a tabela `carts` (reengajamento) é adicionada no PBI de carrinho.
 */
export function CartProvider({ tenantSlug, children }: { tenantSlug: string; children: ReactNode }) {
  const storageKey = `${STORAGE_PREFIX}${tenantSlug}`
  const [state, setState] = useState<CartState>(EMPTY_CART)
  const [hydrated, setHydrated] = useState(false)
  const [authenticated, setAuthenticated] = useState(false)

  // Só sincroniza com o banco quando há sessão: visitante anônimo fica no
  // localStorage até completar o cadastro.
  useEffect(() => {
    const supabase = createClient()
    void supabase.auth.getSession().then(({ data }) => setAuthenticated(Boolean(data.session)))
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthenticated(Boolean(session))
    })
    return () => listener.subscription.unsubscribe()
  }, [])

  // Hidrata do localStorage apenas no cliente, evitando divergência com o SSR.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey)
      if (raw) {
        const parsed = JSON.parse(raw) as CartState
        if (Array.isArray(parsed.items)) setState({ tenantSlug, items: parsed.items })
      }
    } catch {
      // localStorage indisponível (modo privado): segue com carrinho vazio.
    }
    setHydrated(true)
  }, [storageKey, tenantSlug])

  useEffect(() => {
    if (!hydrated) return
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(state))
    } catch {
      // Cota estourada ou storage bloqueado: o carrinho segue só em memória.
    }
  }, [state, storageKey, hydrated])

  const addItem = useCallback((item: Omit<CartItem, 'lineId'>) => {
    const lineId = buildLineKey(item.productId, item.selectedOptions)
    setState((current) => {
      const existing = current.items.find((line) => line.lineId === lineId)
      const items = existing
        ? current.items.map((line) =>
            line.lineId === lineId ? { ...line, quantity: line.quantity + item.quantity } : line,
          )
        : [...current.items, { ...item, lineId }]
      return { tenantSlug: current.tenantSlug ?? null, items }
    })
  }, [])

  const updateQuantity = useCallback((lineId: string, quantity: number) => {
    setState((current) => ({
      ...current,
      items:
        quantity <= 0
          ? current.items.filter((line) => line.lineId !== lineId)
          : current.items.map((line) => (line.lineId === lineId ? { ...line, quantity } : line)),
    }))
  }, [])

  const removeItem = useCallback((lineId: string) => {
    setState((current) => ({ ...current, items: current.items.filter((line) => line.lineId !== lineId) }))
  }, [])

  const clear = useCallback(() => setState({ tenantSlug, items: [] }), [tenantSlug])

  useCartSync(tenantSlug, state.items, authenticated && hydrated)

  const value = useMemo<CartContextValue>(() => {
    const subtotal = round2(
      state.items.reduce((total, line) => total + line.unitPrice * line.quantity, 0),
    )
    const itemCount = state.items.reduce((total, line) => total + line.quantity, 0)
    return { items: state.items, subtotal, itemCount, addItem, updateQuantity, removeItem, clear }
  }, [state.items, addItem, updateQuantity, removeItem, clear])

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}

export function useCart(): CartContextValue {
  const context = useContext(CartContext)
  if (!context) throw new Error('useCart precisa estar dentro de <CartProvider>')
  return context
}
