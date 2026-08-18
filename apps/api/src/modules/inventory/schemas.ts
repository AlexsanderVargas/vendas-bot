import { Type, type Static } from '@sinclair/typebox'
import { Uuid } from '@vendas-bot/shared'

export const UNITS = ['g', 'kg', 'ml', 'l', 'un'] as const
export const UnitSchema = Type.Union(UNITS.map((unit) => Type.Literal(unit)))
export type Unit = (typeof UNITS)[number]

/** Contrato de saída de fornecedor. */
export const Supplier = Type.Object({
  id: Uuid,
  name: Type.String(),
  document: Type.Union([Type.String(), Type.Null()]),
  email: Type.Union([Type.String(), Type.Null()]),
  phone: Type.Union([Type.String(), Type.Null()]),
  contactName: Type.Union([Type.String(), Type.Null()]),
  notes: Type.Union([Type.String(), Type.Null()]),
  isActive: Type.Boolean(),
})

export const SupplierInput = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 160 }),
  document: Type.Optional(Type.Union([Type.String({ pattern: '^[0-9]{11}$|^[0-9]{14}$' }), Type.Null()])),
  email: Type.Optional(Type.Union([Type.String({ format: 'email', maxLength: 160 }), Type.Null()])),
  phone: Type.Optional(Type.Union([Type.String({ maxLength: 20 }), Type.Null()])),
  contactName: Type.Optional(Type.Union([Type.String({ maxLength: 120 }), Type.Null()])),
  notes: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
  isActive: Type.Optional(Type.Boolean()),
})

/** Contrato de saída de insumo. */
export const Ingredient = Type.Object({
  id: Uuid,
  name: Type.String(),
  sku: Type.Union([Type.String(), Type.Null()]),
  baseUnit: UnitSchema,
  averageCost: Type.Number(),
  stockQuantity: Type.Number(),
  minimumStock: Type.Number(),
  isPerishable: Type.Boolean(),
  shelfLifeDays: Type.Union([Type.Integer(), Type.Null()]),
  isActive: Type.Boolean(),
  /** Derivado: estoque atual igual ou abaixo do mínimo configurado. */
  belowMinimum: Type.Boolean(),
})
export type Ingredient = Static<typeof Ingredient>

export const IngredientInput = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  sku: Type.Optional(Type.Union([Type.String({ maxLength: 40 }), Type.Null()])),
  baseUnit: UnitSchema,
  minimumStock: Type.Optional(Type.Number({ minimum: 0 })),
  isPerishable: Type.Optional(Type.Boolean()),
  shelfLifeDays: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
  isActive: Type.Optional(Type.Boolean()),
})

export const IngredientListQuery = Type.Object({
  search: Type.Optional(Type.String({ maxLength: 120 })),
  belowMinimum: Type.Optional(Type.Boolean()),
})

export const IdParams = Type.Object({ id: Uuid })
