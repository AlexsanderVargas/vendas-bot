/**
 * Tipos do cardápio público (DTOs de transporte, sem readonly para casar com
 * os tipos derivados dos schemas TypeBox da API) — fonte única consumida pela API (que os espelha
 * em schemas TypeBox para validação) e pelo frontend.
 * REGRA 4: formatos de saída estáveis.
 */

export interface MenuOption {
  id: string
  name: string
  priceDelta: number
  isAvailable: boolean
}

export interface MenuOptionGroup {
  id: string
  name: string
  selectionType: 'single' | 'multiple'
  minSelect: number
  maxSelect: number
  options: MenuOption[]
}

export interface MenuProduct {
  id: string
  name: string
  description: string | null
  price: number
  imageUrl: string | null
  isAvailable: boolean
  optionGroups: MenuOptionGroup[]
}

export interface MenuCategory {
  id: string
  name: string
  description: string | null
  products: MenuProduct[]
}

export interface GeoPoint {
  latitude: number
  longitude: number
}

export interface MenuTenant {
  id: string
  slug: string
  name: string
  deliveryFeeMode: 'distance' | 'neighborhood' | 'fixed'
  address: {
    street: string | null
    number: string | null
    neighborhood: string | null
    city: string | null
    state: string | null
    zipCode: string | null
  }
  location: GeoPoint | null
}

export interface MenuResponse {
  tenant: MenuTenant
  categories: MenuCategory[]
  /** Produtos ativos sem categoria atribuída. */
  uncategorized: MenuProduct[]
}
