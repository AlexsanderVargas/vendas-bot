import type { SupabaseClient } from '@supabase/supabase-js'
import type { Static } from '@sinclair/typebox'
import type { Order } from './schemas.js'

type OrderDto = Static<typeof Order>

export const ORDER_COLUMNS =
  'id, order_number, status, payment_status, channel, subtotal, discount, delivery_fee, total, notes, delivery_address, created_at, placed_at, delivered_at'

export const ORDER_ITEM_COLUMNS =
  'id, order_id, product_name, unit_price, quantity, total, notes, selected_options'

interface OrderRow {
  id: string
  order_number: number | string
  status: OrderDto['status']
  payment_status: OrderDto['paymentStatus']
  channel: OrderDto['channel']
  subtotal: string | number
  discount: string | number
  delivery_fee: string | number
  total: string | number
  notes: string | null
  delivery_address: unknown
  created_at: string
  placed_at: string | null
  delivered_at: string | null
}

interface OrderItemRow {
  id: string
  order_id?: string
  product_name: string
  unit_price: string | number
  quantity: string | number
  total: string | number
  notes: string | null
  selected_options: unknown
}

/** Contrato: (row) -> OrderDto['items'][number] */
export function toOrderItem(row: OrderItemRow): OrderDto['items'][number] {
  const options = Array.isArray(row.selected_options)
    ? (row.selected_options as Array<Record<string, unknown>>)
    : []
  return {
    id: row.id,
    productName: row.product_name,
    unitPrice: Number(row.unit_price),
    quantity: Number(row.quantity),
    total: Number(row.total),
    notes: row.notes,
    selectedOptions: options.map((option) => ({
      groupName: String(option.groupName ?? ''),
      optionName: String(option.optionName ?? ''),
      priceDelta: Number(option.priceDelta ?? 0),
    })),
  }
}

/** Contrato: (row, items) -> OrderDto */
export function toOrder(row: OrderRow, items: readonly OrderItemRow[]): OrderDto {
  return {
    id: row.id,
    orderNumber: Number(row.order_number),
    status: row.status,
    paymentStatus: row.payment_status,
    channel: row.channel,
    subtotal: Number(row.subtotal),
    discount: Number(row.discount),
    deliveryFee: Number(row.delivery_fee),
    total: Number(row.total),
    notes: row.notes,
    deliveryAddress: row.delivery_address ?? null,
    createdAt: row.created_at,
    placedAt: row.placed_at,
    deliveredAt: row.delivered_at,
    items: items.map(toOrderItem),
  }
}

/**
 * Contrato: (supabase, filters) -> Promise<OrderDto[]>
 * Histórico do cliente. A RLS já restringe às linhas do próprio cliente
 * (ou do tenant, quando quem chama é funcionário).
 */
export async function listOrders(
  supabase: SupabaseClient,
  options: { tenantId?: string | null; limit: number; offset: number },
): Promise<OrderDto[]> {
  let query = supabase
    .from('orders')
    .select(ORDER_COLUMNS)
    .order('created_at', { ascending: false })
    .range(options.offset, options.offset + options.limit - 1)

  if (options.tenantId) query = query.eq('tenant_id', options.tenantId)

  const { data, error } = await query
  if (error) throw new Error(error.message)

  const rows = (data ?? []) as OrderRow[]
  if (rows.length === 0) return []

  const { data: items } = await supabase
    .from('order_items')
    .select(ORDER_ITEM_COLUMNS)
    .in(
      'order_id',
      rows.map((row) => row.id),
    )

  const itemsByOrder = new Map<string, OrderItemRow[]>()
  for (const item of (items ?? []) as OrderItemRow[]) {
    const bucket = itemsByOrder.get(item.order_id!) ?? []
    bucket.push(item)
    itemsByOrder.set(item.order_id!, bucket)
  }

  return rows.map((row) => toOrder(row, itemsByOrder.get(row.id) ?? []))
}

/**
 * Mapa de erro de negócio -> status HTTP. Mantido junto do contrato da função
 * SQL para que os dois evoluam lado a lado.
 */
export const CHECKOUT_ERROR_STATUS: Record<string, number> = {
  nao_autorizado: 403,
  estabelecimento_inativo: 409,
  carrinho_vazio: 400,
  produto_indisponivel: 409,
  opcional_invalido: 400,
  opcionais_obrigatorios: 400,
  endereco_invalido: 400,
}

export const CHECKOUT_ERROR_MESSAGE: Record<string, string> = {
  nao_autorizado: 'Você não pode fazer pedidos em nome deste cliente.',
  estabelecimento_inativo: 'Estabelecimento indisponível no momento.',
  carrinho_vazio: 'Adicione itens ao carrinho antes de finalizar.',
  produto_indisponivel: 'Um dos itens ficou indisponível. Revise o carrinho.',
  opcional_invalido: 'Há opcionais inválidos no pedido.',
  opcionais_obrigatorios: 'Revise os opcionais obrigatórios dos itens.',
  endereco_invalido: 'Selecione um endereço de entrega válido.',
  'entrega_indisponivel:fora_da_area': 'Endereço fora da área de entrega.',
  'entrega_indisponivel:bairro_nao_atendido': 'Ainda não entregamos neste bairro.',
  'entrega_indisponivel:pedido_minimo': 'Pedido abaixo do mínimo para entrega.',
  'entrega_indisponivel:sem_localizacao': 'Não foi possível localizar o endereço informado.',
}

/** Contrato: (error) -> { status, message } */
export function mapCheckoutError(error: string): { status: number; message: string } {
  const status = error.startsWith('entrega_indisponivel:')
    ? 409
    : (CHECKOUT_ERROR_STATUS[error] ?? 400)
  const message = CHECKOUT_ERROR_MESSAGE[error] ?? 'Não foi possível concluir o pedido.'
  return { status, message }
}

export const ADVANCE_ERROR_STATUS: Record<string, number> = {
  pedido_nao_encontrado: 404,
  nao_autorizado: 403,
  transicao_invalida: 409,
}

export const ADVANCE_ERROR_MESSAGE: Record<string, string> = {
  pedido_nao_encontrado: 'Pedido não encontrado.',
  nao_autorizado: 'Você não pode alterar o status deste pedido.',
  transicao_invalida: 'Esta mudança de status não é permitida a partir do estado atual.',
}

/** Contrato: (error) -> { status, message } */
export function mapAdvanceError(error: string): { status: number; message: string } {
  return {
    status: ADVANCE_ERROR_STATUS[error] ?? 400,
    message: ADVANCE_ERROR_MESSAGE[error] ?? 'Não foi possível alterar o status do pedido.',
  }
}
