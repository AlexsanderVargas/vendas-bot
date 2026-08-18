import type { SupabaseClient } from '@supabase/supabase-js'
import type { CartItem } from './schemas.js'

interface CartItemRow {
  line_key: string
  product_id: string
  quantity: string | number
  notes: string | null
  selected_options: unknown
}

/** Contrato: (rows) -> CartItem[] — normaliza as linhas do banco. */
export function toCartItems(rows: readonly CartItemRow[]): CartItem[] {
  return rows.map((row) => ({
    lineKey: row.line_key,
    productId: row.product_id,
    quantity: Number(row.quantity),
    notes: row.notes,
    selectedOptions: Array.isArray(row.selected_options)
      ? (row.selected_options as CartItem['selectedOptions'])
      : [],
  }))
}

/**
 * Contrato: (supabase, tenantId, customerId) -> Promise<string>
 * Devolve o id do carrinho aberto do cliente, criando-o se necessário.
 * A constraint carts_customer_unique garante um único carrinho por
 * (tenant, cliente), então o upsert é idempotente sob concorrência.
 */
export async function ensureCart(
  supabase: SupabaseClient,
  tenantId: string,
  customerId: string,
): Promise<string> {
  const { data, error } = await supabase
    .from('carts')
    .upsert({ tenant_id: tenantId, customer_id: customerId }, { onConflict: 'tenant_id,customer_id' })
    .select('id')
    .single()

  if (error) throw new Error(error.message)
  return data.id as string
}

/**
 * Contrato: (supabase, cartId, items) -> Promise<void>
 * Substitui o conteúdo do carrinho pelo estado enviado pelo cliente
 * (o localStorage é a fonte da verdade durante a navegação). Apaga o que
 * saiu e faz upsert do restante, em vez de recriar tudo — preserva created_at
 * e evita churn de ids.
 */
export async function replaceCartItems(
  supabase: SupabaseClient,
  cartId: string,
  items: readonly CartItem[],
): Promise<void> {
  const keys = items.map((item) => item.lineKey)

  const deletion = supabase.from('cart_items').delete().eq('cart_id', cartId)
  const { error: deleteError } = await (keys.length > 0
    ? deletion.not('line_key', 'in', `(${keys.map((key) => `"${key}"`).join(',')})`)
    : deletion)
  if (deleteError) throw new Error(deleteError.message)

  if (items.length === 0) return

  const { error } = await supabase.from('cart_items').upsert(
    items.map((item) => ({
      cart_id: cartId,
      product_id: item.productId,
      line_key: item.lineKey,
      quantity: item.quantity,
      notes: item.notes,
      selected_options: item.selectedOptions,
    })),
    { onConflict: 'cart_id,line_key' },
  )
  if (error) throw new Error(error.message)
}
