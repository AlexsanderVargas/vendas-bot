import { Type } from '@sinclair/typebox'

/**
 * Espelho dos enums do banco (supabase/migrations). Manter em sincronia:
 * qualquer ALTER TYPE ... ADD VALUE precisa ser refletido aqui.
 */

export const ORDER_CHANNELS = ['delivery', 'takeaway', 'dine_in'] as const
export type OrderChannel = (typeof ORDER_CHANNELS)[number]
export const OrderChannelSchema = Type.Union(ORDER_CHANNELS.map((c) => Type.Literal(c)))

export const ORDER_STATUSES = [
  'draft',
  'placed',
  'confirmed',
  'preparing',
  'ready',
  'out_for_delivery',
  'delivered',
  'completed',
  'canceled',
] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]
export const OrderStatusSchema = Type.Union(ORDER_STATUSES.map((s) => Type.Literal(s)))

export const PAYMENT_STATUSES = ['pending', 'paid', 'refunded', 'failed'] as const
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number]
export const PaymentStatusSchema = Type.Union(PAYMENT_STATUSES.map((s) => Type.Literal(s)))

export const DELIVERY_FEE_MODES = ['distance', 'neighborhood', 'fixed'] as const
export type DeliveryFeeMode = (typeof DELIVERY_FEE_MODES)[number]
export const DeliveryFeeModeSchema = Type.Union(DELIVERY_FEE_MODES.map((m) => Type.Literal(m)))

/** Chaves dos papéis de sistema semeados em 20260818000003_core_tenancy.sql. */
export const SYSTEM_ROLE_KEYS = ['owner', 'manager', 'cashier', 'waiter', 'kitchen'] as const
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number]

/**
 * Transições de status permitidas. Fonte da verdade para o serviço de pedidos
 * e para o KDS — evita saltos inválidos (ex.: placed -> delivered).
 */
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  draft: ['placed', 'canceled'],
  placed: ['confirmed', 'canceled'],
  confirmed: ['preparing', 'canceled'],
  preparing: ['ready', 'canceled'],
  ready: ['out_for_delivery', 'delivered', 'completed', 'canceled'],
  out_for_delivery: ['delivered', 'canceled'],
  delivered: ['completed'],
  completed: [],
  canceled: [],
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_STATUS_TRANSITIONS[from].includes(to)
}
