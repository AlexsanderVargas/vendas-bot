import type { SupabaseClient } from '@supabase/supabase-js'
import type { GeoPoint, MenuProduct, MenuResponse, MenuTenant } from './types.js'

interface OptionRow {
  id: string
  group_id: string
  name: string
  price_delta: string | number
  is_available: boolean
}

interface GroupRow {
  id: string
  product_id: string
  name: string
  selection_type: 'single' | 'multiple'
  min_select: number
  max_select: number
}

interface ProductRow {
  id: string
  category_id: string | null
  name: string
  description: string | null
  price: string | number
  image_url: string | null
  is_available: boolean
}

/**
 * Contrato: (supabase, slug) -> Promise<MenuResponse | null>
 * Monta o cardápio público de um estabelecimento. Null quando o slug não
 * existe ou o tenant está inativo (a RLS já filtra inativos para anônimos).
 *
 * Implementação única compartilhada entre a API (rota pública) e o frontend
 * (renderização no servidor). Usa consultas separadas em vez de joins
 * aninhados para manter os índices em uso (products_menu_idx,
 * option_groups_product_idx) e o payload previsível.
 */
const TENANT_COLUMNS =
  'id, slug, name, delivery_fee_mode, address_street, address_number, neighborhood, city, state, zip_code, location'

/** Contrato: (row) -> MenuTenant */
function toMenuTenant(tenant: Record<string, unknown>): MenuTenant {
  return {
    id: tenant.id as string,
    slug: tenant.slug as string,
    name: tenant.name as string,
    deliveryFeeMode: tenant.delivery_fee_mode as MenuTenant['deliveryFeeMode'],
    address: {
      street: tenant.address_street as string,
      number: tenant.address_number as string,
      neighborhood: tenant.neighborhood as string,
      city: tenant.city as string,
      state: tenant.state as string,
      zipCode: tenant.zip_code as string,
    },
    location: parseLocation(tenant.location),
  }
}

/**
 * Contrato: (supabase, slug) -> Promise<MenuTenant | null>
 *
 * Só o estabelecimento, sem cardápio. Existe para telas que precisam do nome e
 * do endereço mas não dos produtos — o checkout, por exemplo, gastava quatro
 * consultas e serializava o cardápio inteiro para usar um punhado de campos.
 */
export async function getMenuTenant(
  supabase: SupabaseClient,
  slug: string,
): Promise<MenuTenant | null> {
  const { data } = await supabase
    .from('tenants')
    .select(TENANT_COLUMNS)
    .eq('slug', slug)
    .eq('is_active', true)
    .maybeSingle()

  return data ? toMenuTenant(data as Record<string, unknown>) : null
}

export async function getPublicMenu(
  supabase: SupabaseClient,
  slug: string,
): Promise<MenuResponse | null> {
  const { data: tenant } = await supabase
    .from('tenants')
    .select(TENANT_COLUMNS)
    .eq('slug', slug)
    .eq('is_active', true)
    .maybeSingle()

  if (!tenant) return null

  const [{ data: categories }, { data: products }] = await Promise.all([
    supabase
      .from('categories')
      .select('id, name, description, sort_order')
      .eq('tenant_id', tenant.id)
      .eq('is_active', true)
      .order('sort_order', { ascending: true }),
    supabase
      .from('products')
      .select('id, category_id, name, description, price, image_url, is_available, sort_order')
      .eq('tenant_id', tenant.id)
      .eq('is_active', true)
      .order('sort_order', { ascending: true }),
  ])

  const productRows = (products ?? []) as ProductRow[]
  const productIds = productRows.map((product) => product.id)

  let groupRows: GroupRow[] = []
  let optionRows: OptionRow[] = []

  if (productIds.length > 0) {
    const { data: groups } = await supabase
      .from('product_option_groups')
      .select('id, product_id, name, selection_type, min_select, max_select, sort_order')
      .in('product_id', productIds)
      .eq('is_active', true)
      .order('sort_order', { ascending: true })

    groupRows = (groups ?? []) as GroupRow[]

    if (groupRows.length > 0) {
      const { data: options } = await supabase
        .from('product_options')
        .select('id, group_id, name, price_delta, is_available, sort_order')
        .in(
          'group_id',
          groupRows.map((group) => group.id),
        )
        .order('sort_order', { ascending: true })
      optionRows = (options ?? []) as OptionRow[]
    }
  }

  const optionsByGroup = groupBy(optionRows, (option) => option.group_id)
  const groupsByProduct = groupBy(groupRows, (group) => group.product_id)

  const toProduct = (row: ProductRow): MenuProduct => ({
    id: row.id,
    name: row.name,
    description: row.description,
    price: Number(row.price),
    imageUrl: row.image_url,
    isAvailable: row.is_available,
    optionGroups: (groupsByProduct.get(row.id) ?? []).map((group) => ({
      id: group.id,
      name: group.name,
      selectionType: group.selection_type,
      minSelect: group.min_select,
      maxSelect: group.max_select,
      options: (optionsByGroup.get(group.id) ?? []).map((option) => ({
        id: option.id,
        name: option.name,
        priceDelta: Number(option.price_delta),
        isAvailable: option.is_available,
      })),
    })),
  })

  const productsByCategory = groupBy(productRows, (product) => product.category_id ?? '')

  return {
    tenant: toMenuTenant(tenant as Record<string, unknown>),
    categories: (categories ?? []).map((category) => ({
      id: category.id,
      name: category.name,
      description: category.description,
      products: (productsByCategory.get(category.id) ?? []).map(toProduct),
    })),
    uncategorized: (productsByCategory.get('') ?? []).map(toProduct),
  }
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const bucketKey = key(item)
    const bucket = map.get(bucketKey)
    if (bucket) bucket.push(item)
    else map.set(bucketKey, [item])
  }
  return map
}

/**
 * PostgREST devolve geography como GeoJSON ou WKB hex, conforme a versão e a
 * configuração do projeto. Só o GeoJSON é interpretável aqui.
 * Contrato: (value) -> GeoPoint | null
 */
export function parseLocation(value: unknown): GeoPoint | null {
  if (!value) return null
  if (typeof value === 'object' && value !== null && 'coordinates' in value) {
    const coords = (value as { coordinates?: unknown }).coordinates
    if (Array.isArray(coords) && coords.length >= 2) {
      const [longitude, latitude] = coords as number[]
      if (typeof latitude === 'number' && typeof longitude === 'number') {
        return { latitude, longitude }
      }
    }
  }
  return null
}
