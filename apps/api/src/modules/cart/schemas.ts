import { Type, type Static } from '@sinclair/typebox'
import { Money, Slug, Uuid } from '@vendas-bot/shared'

export const SelectedOption = Type.Object({
  groupId: Uuid,
  groupName: Type.String(),
  optionId: Uuid,
  optionName: Type.String(),
  priceDelta: Type.Number(),
})

export const CartItem = Type.Object({
  lineKey: Type.String({ minLength: 1, maxLength: 400 }),
  productId: Uuid,
  quantity: Type.Number({ exclusiveMinimum: 0, maximum: 999 }),
  notes: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
  selectedOptions: Type.Array(SelectedOption),
})
export type CartItem = Static<typeof CartItem>

/** Contrato de saída do carrinho sincronizado. */
export const Cart = Type.Object({
  id: Type.Union([Uuid, Type.Null()]),
  tenantSlug: Slug,
  items: Type.Array(CartItem),
  updatedAt: Type.Union([Type.String(), Type.Null()]),
})

export const CartQuery = Type.Object({ tenantSlug: Slug })

export const CartSyncInput = Type.Object({
  tenantSlug: Slug,
  items: Type.Array(CartItem, { maxItems: 100 }),
  notes: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
})

export const SuggestionInput = Type.Object({
  tenantSlug: Slug,
  categoryIds: Type.Array(Uuid, { maxItems: 50, default: [] }),
  excludeProductIds: Type.Array(Uuid, { maxItems: 100, default: [] }),
  limit: Type.Integer({ minimum: 0, maximum: 10, default: 3 }),
})

/** Contrato de saída das sugestões de upsell/cross-sell. */
export const Suggestion = Type.Object({
  id: Uuid,
  name: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  price: Money,
  imageUrl: Type.Union([Type.String(), Type.Null()]),
})
