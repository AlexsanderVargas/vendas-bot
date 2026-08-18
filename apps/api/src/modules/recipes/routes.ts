import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import { Money, StandardErrors, Uuid } from '@vendas-bot/shared'
import { UnitSchema } from '../inventory/schemas.js'

/** Linha da ficha técnica, já resolvida com dados do insumo. */
const RecipeLine = Type.Object({
  id: Uuid,
  ingredientId: Uuid,
  ingredientName: Type.String(),
  baseUnit: UnitSchema,
  quantity: Type.Number(),
  wastePercent: Type.Number(),
  /** Quantidade consumida do estoque, já com a perda de preparo. */
  effectiveQuantity: Type.Number(),
  unitCost: Type.Number(),
  lineCost: Money,
  notes: Type.Union([Type.String(), Type.Null()]),
})

/** Contrato de saída da ficha técnica de um produto. */
const Recipe = Type.Object({
  productId: Uuid,
  productName: Type.String(),
  price: Money,
  cmv: Money,
  margin: Type.Number(),
  marginPercent: Type.Number(),
  hasRecipe: Type.Boolean(),
  lines: Type.Array(RecipeLine),
})

const RecipeLineInput = Type.Object({
  ingredientId: Uuid,
  quantity: Type.Number({ exclusiveMinimum: 0 }),
  wastePercent: Type.Optional(Type.Number({ minimum: 0, exclusiveMaximum: 100 })),
  notes: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
})

const ProductParams = Type.Object({ productId: Uuid })
const LineParams = Type.Object({ productId: Uuid, lineId: Uuid })

/** Contrato: (quantity, wastePercent) -> number — espelha recipe_effective_quantity. */
export function effectiveQuantity(quantity: number, wastePercent: number): number {
  return Math.round((quantity / (1 - (wastePercent || 0) / 100)) * 10000) / 10000
}

const recipeRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/products/:productId/recipe',
    {
      onRequest: app.requirePermission('inventory.read'),
      schema: {
        tags: ['ficha técnica'],
        description: 'Ficha técnica do produto com CMV e margem.',
        params: ProductParams,
        response: { 200: Recipe, ...StandardErrors },
      },
    },
    async (request) => {
      const { data: product } = await request.supabase
        .from('products')
        .select('id, name, price')
        .eq('id', request.params.productId)
        .maybeSingle()

      if (!product) throw app.httpErrors.notFound('Produto não encontrado')

      const [{ data: lines }, { data: margin }] = await Promise.all([
        request.supabase
          .from('product_recipes')
          .select('id, ingredient_id, quantity, waste_percent, notes, ingredients(name, base_unit, average_cost)')
          .eq('product_id', request.params.productId),
        request.supabase.rpc('product_margin', { p_product_id: request.params.productId }),
      ])

      const summary = (margin ?? {}) as Record<string, unknown>

      return {
        productId: product.id,
        productName: product.name,
        price: Number(product.price),
        cmv: Number(summary.cmv ?? 0),
        margin: Number(summary.margin ?? 0),
        marginPercent: Number(summary.marginPercent ?? 0),
        hasRecipe: Boolean(summary.hasRecipe),
        lines: (lines ?? []).map((row: Record<string, unknown>) => {
          const ingredient = (row.ingredients ?? {}) as Record<string, unknown>
          const quantity = Number(row.quantity)
          const wastePercent = Number(row.waste_percent)
          const unitCost = Number(ingredient.average_cost ?? 0)
          const effective = effectiveQuantity(quantity, wastePercent)
          return {
            id: String(row.id),
            ingredientId: String(row.ingredient_id),
            ingredientName: String(ingredient.name ?? ''),
            baseUnit: (ingredient.base_unit ?? 'un') as never,
            quantity,
            wastePercent,
            effectiveQuantity: effective,
            unitCost,
            lineCost: Math.round(effective * unitCost * 100) / 100,
            notes: (row.notes as string | null) ?? null,
          }
        }),
      }
    },
  )

  app.post(
    '/products/:productId/recipe',
    {
      onRequest: app.requirePermission('inventory.write'),
      schema: {
        tags: ['ficha técnica'],
        description: 'Adiciona um insumo à ficha técnica do produto.',
        params: ProductParams,
        body: RecipeLineInput,
        response: { 201: Type.Object({ id: Uuid }), ...StandardErrors },
      },
    },
    async (request, reply) => {
      const tenantId = request.requireTenantId()
      const { data, error } = await request.supabase
        .from('product_recipes')
        .insert({
          tenant_id: tenantId,
          product_id: request.params.productId,
          ingredient_id: request.body.ingredientId,
          quantity: request.body.quantity,
          waste_percent: request.body.wastePercent ?? 0,
          notes: request.body.notes ?? null,
        })
        .select('id')
        .single()

      if (error) throw app.httpErrors.badRequest(error.message)
      return reply.status(201).send({ id: data.id })
    },
  )

  app.delete(
    '/products/:productId/recipe/:lineId',
    {
      onRequest: app.requirePermission('inventory.write'),
      schema: {
        tags: ['ficha técnica'],
        description: 'Remove um insumo da ficha técnica.',
        params: LineParams,
        response: { 204: Type.Null(), ...StandardErrors },
      },
    },
    async (request, reply) => {
      const { error } = await request.supabase
        .from('product_recipes')
        .delete()
        .eq('id', request.params.lineId)
        .eq('product_id', request.params.productId)

      if (error) throw app.httpErrors.badRequest(error.message)
      return reply.status(204).send(null)
    },
  )
}

export default recipeRoutes
