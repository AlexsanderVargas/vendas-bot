import { Type, type Static } from '@sinclair/typebox'
import { Money, Slug, Uuid } from '@vendas-bot/shared'

const Latitude = Type.Number({ minimum: -90, maximum: 90 })
const Longitude = Type.Number({ minimum: -180, maximum: 180 })

/** Contrato de saída de um endereço do cliente. */
export const Address = Type.Object({
  id: Uuid,
  label: Type.String(),
  street: Type.String(),
  number: Type.String(),
  complement: Type.Union([Type.String(), Type.Null()]),
  neighborhood: Type.String(),
  city: Type.String(),
  state: Type.String(),
  zipCode: Type.Union([Type.String(), Type.Null()]),
  reference: Type.Union([Type.String(), Type.Null()]),
  latitude: Type.Union([Latitude, Type.Null()]),
  longitude: Type.Union([Longitude, Type.Null()]),
  isDefault: Type.Boolean(),
})
export type Address = Static<typeof Address>

export const AddressInput = Type.Object({
  tenantSlug: Slug,
  label: Type.String({ minLength: 1, maxLength: 40, default: 'Casa' }),
  street: Type.String({ minLength: 1, maxLength: 160 }),
  number: Type.String({ minLength: 1, maxLength: 20 }),
  complement: Type.Optional(Type.Union([Type.String({ maxLength: 80 }), Type.Null()])),
  neighborhood: Type.String({ minLength: 1, maxLength: 120 }),
  city: Type.String({ minLength: 1, maxLength: 120 }),
  state: Type.String({ minLength: 2, maxLength: 2 }),
  zipCode: Type.Optional(Type.Union([Type.String({ pattern: '^[0-9]{8}$' }), Type.Null()])),
  reference: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
  latitude: Type.Optional(Type.Union([Latitude, Type.Null()])),
  longitude: Type.Optional(Type.Union([Longitude, Type.Null()])),
  isDefault: Type.Optional(Type.Boolean()),
})

export const AddressUpdate = Type.Partial(Type.Omit(AddressInput, ['tenantSlug']))

export const AddressListQuery = Type.Object({ tenantSlug: Slug })
export const AddressParams = Type.Object({ id: Uuid })

/** Contrato de entrada da cotação de frete (aceita visitante anônimo). */
export const DeliveryQuoteInput = Type.Object({
  tenantSlug: Slug,
  subtotal: Money,
  latitude: Type.Optional(Type.Union([Latitude, Type.Null()])),
  longitude: Type.Optional(Type.Union([Longitude, Type.Null()])),
  neighborhood: Type.Optional(Type.Union([Type.String({ maxLength: 120 }), Type.Null()])),
  city: Type.Optional(Type.Union([Type.String({ maxLength: 120 }), Type.Null()])),
})

/** Contrato de saída da cotação — espelha o jsonb de public.quote_delivery. */
export const DeliveryQuote = Type.Object({
  eligible: Type.Boolean(),
  fee: Type.Number(),
  mode: Type.Union([
    Type.Literal('distance'),
    Type.Literal('neighborhood'),
    Type.Literal('fixed'),
    Type.Null(),
  ]),
  distanceMeters: Type.Union([Type.Number(), Type.Null()]),
  etaMinutes: Type.Union([Type.Integer(), Type.Null()]),
  minOrder: Type.Number(),
  reason: Type.Union([Type.String(), Type.Null()]),
})
export type DeliveryQuote = Static<typeof DeliveryQuote>
