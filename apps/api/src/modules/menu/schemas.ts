import { Type, type Static } from '@sinclair/typebox'
import { Money, Slug, Uuid } from '@vendas-bot/shared'

/**
 * Contratos do cardápio público. REGRA 4: formatos de saída estáveis —
 * o frontend do cliente final depende deles.
 */

export const MenuOption = Type.Object({
  id: Uuid,
  name: Type.String(),
  priceDelta: Type.Number(),
  isAvailable: Type.Boolean(),
})

export const MenuOptionGroup = Type.Object({
  id: Uuid,
  name: Type.String(),
  selectionType: Type.Union([Type.Literal('single'), Type.Literal('multiple')]),
  minSelect: Type.Integer(),
  maxSelect: Type.Integer(),
  options: Type.Array(MenuOption),
})

export const MenuProduct = Type.Object({
  id: Uuid,
  name: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  price: Money,
  imageUrl: Type.Union([Type.String(), Type.Null()]),
  isAvailable: Type.Boolean(),
  optionGroups: Type.Array(MenuOptionGroup),
})

export const MenuCategory = Type.Object({
  id: Uuid,
  name: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  products: Type.Array(MenuProduct),
})

export const MenuTenant = Type.Object({
  id: Uuid,
  slug: Slug,
  name: Type.String(),
  deliveryFeeMode: Type.Union([
    Type.Literal('distance'),
    Type.Literal('neighborhood'),
    Type.Literal('fixed'),
  ]),
  address: Type.Object({
    street: Type.Union([Type.String(), Type.Null()]),
    number: Type.Union([Type.String(), Type.Null()]),
    neighborhood: Type.Union([Type.String(), Type.Null()]),
    city: Type.Union([Type.String(), Type.Null()]),
    state: Type.Union([Type.String(), Type.Null()]),
    zipCode: Type.Union([Type.String(), Type.Null()]),
  }),
  location: Type.Union([
    Type.Object({ latitude: Type.Number(), longitude: Type.Number() }),
    Type.Null(),
  ]),
})

/** Contrato de saída de GET /public/menu/:slug */
export const MenuResponse = Type.Object({
  tenant: MenuTenant,
  categories: Type.Array(MenuCategory),
  /** Produtos ativos sem categoria atribuída. */
  uncategorized: Type.Array(MenuProduct),
})
export type MenuResponse = Static<typeof MenuResponse>

export const MenuParams = Type.Object({ slug: Slug })
