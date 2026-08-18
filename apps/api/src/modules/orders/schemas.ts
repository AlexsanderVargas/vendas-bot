import { Type, type Static } from '@sinclair/typebox'
import { Money, Slug, Uuid } from '@vendas-bot/shared'
import { OrderChannelSchema, OrderStatusSchema, PaymentStatusSchema } from '@vendas-bot/shared'

export const CheckoutItem = Type.Object({
  productId: Uuid,
  quantity: Type.Number({ exclusiveMinimum: 0, maximum: 999 }),
  notes: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
  optionIds: Type.Array(Uuid, { maxItems: 30, default: [] }),
})

export const CheckoutInput = Type.Object({
  tenantSlug: Slug,
  channel: OrderChannelSchema,
  items: Type.Array(CheckoutItem, { minItems: 1, maxItems: 100 }),
  addressId: Type.Optional(Type.Union([Uuid, Type.Null()])),
  notes: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
})
export type CheckoutInput = Static<typeof CheckoutInput>

/** Contrato de saída do checkout — espelha o jsonb de public.checkout_order. */
export const CheckoutResult = Type.Object({
  id: Uuid,
  orderNumber: Type.Integer(),
  status: OrderStatusSchema,
  channel: OrderChannelSchema,
  subtotal: Money,
  deliveryFee: Money,
  total: Money,
  etaMinutes: Type.Union([Type.Integer(), Type.Null()]),
})

export const OrderItem = Type.Object({
  id: Uuid,
  productName: Type.String(),
  unitPrice: Money,
  quantity: Type.Number(),
  total: Money,
  notes: Type.Union([Type.String(), Type.Null()]),
  selectedOptions: Type.Array(
    Type.Object({
      groupName: Type.String(),
      optionName: Type.String(),
      priceDelta: Type.Number(),
    }),
  ),
})

/** Contrato de saída de um pedido do cliente. */
export const Order = Type.Object({
  id: Uuid,
  orderNumber: Type.Integer(),
  status: OrderStatusSchema,
  paymentStatus: PaymentStatusSchema,
  channel: OrderChannelSchema,
  subtotal: Money,
  discount: Money,
  deliveryFee: Money,
  total: Money,
  notes: Type.Union([Type.String(), Type.Null()]),
  deliveryAddress: Type.Union([Type.Unknown(), Type.Null()]),
  createdAt: Type.String(),
  placedAt: Type.Union([Type.String(), Type.Null()]),
  deliveredAt: Type.Union([Type.String(), Type.Null()]),
  items: Type.Array(OrderItem),
})

export const OrderListQuery = Type.Object({
  tenantSlug: Type.Optional(Slug),
  limit: Type.Integer({ minimum: 1, maximum: 50, default: 20 }),
  offset: Type.Integer({ minimum: 0, default: 0 }),
})

export const OrderParams = Type.Object({ id: Uuid })

/** Evento da linha do tempo do pedido. */
export const OrderStatusEvent = Type.Object({
  id: Uuid,
  status: OrderStatusSchema,
  note: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
})

export const AdvanceStatusInput = Type.Object({
  status: OrderStatusSchema,
  note: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
})

/** Contrato de saída da mudança de status. */
export const AdvanceStatusResult = Type.Object({
  id: Uuid,
  status: OrderStatusSchema,
})
