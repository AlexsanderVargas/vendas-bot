import type { SelectedOptionSnapshot } from '@vendas-bot/shared'

export interface CartItem {
  /** Identidade local da linha (produto + combinação de opcionais). */
  lineId: string
  productId: string
  productName: string
  unitPrice: number
  quantity: number
  notes: string | null
  selectedOptions: SelectedOptionSnapshot[]
}

export interface CartState {
  tenantSlug: string | null
  items: CartItem[]
}

export const EMPTY_CART: CartState = { tenantSlug: null, items: [] }
