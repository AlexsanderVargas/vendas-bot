import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import { StandardErrors } from '@vendas-bot/shared'
import {
  ConsumeResult,
  ConsumeStockInput,
  IdParams,
  Ingredient,
  IngredientInput,
  IngredientListQuery,
  ReceiveStockInput,
  StockAlert,
  StockAlertQuery,
  StockMovement,
  StockOperationResult,
  Supplier,
  SupplierInput,
} from './schemas.js'
import {
  INGREDIENT_COLUMNS,
  mapStockError,
  SUPPLIER_COLUMNS,
  toIngredient,
  toSupplier,
} from './service.js'

/**
 * Rotas internas de estoque. Todas exigem funcionário com permissão —
 * a RLS restringe ao tenant e o requirePermission ao papel.
 */
const inventoryRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // ------------------------------- fornecedores -------------------------------
  app.get(
    '/suppliers',
    {
      onRequest: app.requirePermission('inventory.read'),
      schema: {
        tags: ['estoque'],
        description: 'Fornecedores do estabelecimento.',
        response: { 200: Type.Array(Supplier), ...StandardErrors },
      },
    },
    async (request) => {
      const { data, error } = await request.supabase
        .from('suppliers')
        .select(SUPPLIER_COLUMNS)
        .order('name', { ascending: true })
      if (error) throw app.httpErrors.internalServerError(error.message)
      return (data ?? []).map(toSupplier)
    },
  )

  app.post(
    '/suppliers',
    {
      onRequest: app.requirePermission('inventory.write'),
      schema: {
        tags: ['estoque'],
        description: 'Cadastra um fornecedor.',
        body: SupplierInput,
        response: { 201: Supplier, ...StandardErrors },
      },
    },
    async (request, reply) => {
      const tenantId = request.requireTenantId()
      const { data, error } = await request.supabase
        .from('suppliers')
        .insert({
          tenant_id: tenantId,
          name: request.body.name,
          document: request.body.document ?? null,
          email: request.body.email ?? null,
          phone: request.body.phone ?? null,
          contact_name: request.body.contactName ?? null,
          notes: request.body.notes ?? null,
          is_active: request.body.isActive ?? true,
        })
        .select(SUPPLIER_COLUMNS)
        .single()

      if (error) throw app.httpErrors.badRequest(error.message)
      return reply.status(201).send(toSupplier(data))
    },
  )

  app.patch(
    '/suppliers/:id',
    {
      onRequest: app.requirePermission('inventory.write'),
      schema: {
        tags: ['estoque'],
        description: 'Atualiza um fornecedor.',
        params: IdParams,
        body: Type.Partial(SupplierInput),
        response: { 200: Supplier, ...StandardErrors },
      },
    },
    async (request) => {
      const { contactName, isActive, ...rest } = request.body
      const patch: Record<string, unknown> = { ...rest }
      if (contactName !== undefined) patch.contact_name = contactName
      if (isActive !== undefined) patch.is_active = isActive

      const { data, error } = await request.supabase
        .from('suppliers')
        .update(patch)
        .eq('id', request.params.id)
        .select(SUPPLIER_COLUMNS)
        .maybeSingle()

      if (error) throw app.httpErrors.badRequest(error.message)
      if (!data) throw app.httpErrors.notFound('Fornecedor não encontrado')
      return toSupplier(data)
    },
  )

  // --------------------------------- insumos ----------------------------------
  app.get(
    '/ingredients',
    {
      onRequest: app.requirePermission('inventory.read'),
      schema: {
        tags: ['estoque'],
        description: 'Insumos do estabelecimento, com filtro de reposição.',
        querystring: IngredientListQuery,
        response: { 200: Type.Array(Ingredient), ...StandardErrors },
      },
    },
    async (request) => {
      let query = request.supabase
        .from('ingredients')
        .select(INGREDIENT_COLUMNS)
        .order('name', { ascending: true })

      if (request.query.search) {
        query = query.ilike('name', `%${request.query.search}%`)
      }

      const { data, error } = await query
      if (error) throw app.httpErrors.internalServerError(error.message)

      const ingredients = (data ?? []).map(toIngredient)
      return request.query.belowMinimum
        ? ingredients.filter((ingredient) => ingredient.belowMinimum)
        : ingredients
    },
  )

  app.post(
    '/ingredients',
    {
      onRequest: app.requirePermission('inventory.write'),
      schema: {
        tags: ['estoque'],
        description: 'Cadastra um insumo.',
        body: IngredientInput,
        response: { 201: Ingredient, ...StandardErrors },
      },
    },
    async (request, reply) => {
      const tenantId = request.requireTenantId()

      // Perecível sem prazo de validade impede o controle FEFO adiante.
      if (request.body.isPerishable && !request.body.shelfLifeDays) {
        throw app.httpErrors.badRequest('Insumo perecível exige prazo de validade em dias')
      }

      const { data, error } = await request.supabase
        .from('ingredients')
        .insert({
          tenant_id: tenantId,
          name: request.body.name,
          sku: request.body.sku ?? null,
          base_unit: request.body.baseUnit,
          minimum_stock: request.body.minimumStock ?? 0,
          is_perishable: request.body.isPerishable ?? false,
          shelf_life_days: request.body.shelfLifeDays ?? null,
          is_active: request.body.isActive ?? true,
        })
        .select(INGREDIENT_COLUMNS)
        .single()

      if (error) throw app.httpErrors.badRequest(error.message)
      return reply.status(201).send(toIngredient(data))
    },
  )

  app.get(
    '/stock/alerts',
    {
      onRequest: app.requirePermission('inventory.read'),
      schema: {
        tags: ['estoque'],
        description: 'Insumos abaixo do mínimo e lotes vencidos ou a vencer.',
        querystring: StockAlertQuery,
        response: { 200: Type.Array(StockAlert), ...StandardErrors },
      },
    },
    async (request) => {
      const tenantId = request.requireTenantId()
      const { data, error } = await request.supabase.rpc('stock_alerts', {
        p_tenant_id: tenantId,
        p_expiring_days: request.query.expiringDays,
      })
      if (error) throw app.httpErrors.internalServerError(error.message)

      return (data ?? []).map((row: Record<string, unknown>) => ({
        kind: row.kind as never,
        ingredientId: String(row.ingredient_id),
        ingredientName: String(row.ingredient_name),
        baseUnit: row.base_unit as never,
        quantity: Number(row.quantity),
        threshold: row.threshold === null ? null : Number(row.threshold),
        expiresAt: (row.expires_at as string | null) ?? null,
        batchCode: (row.batch_code as string | null) ?? null,
      }))
    },
  )

  // ------------------------------ estoque -------------------------------------
  app.post(
    '/ingredients/:id/receive',
    {
      onRequest: app.requirePermission('inventory.write'),
      schema: {
        tags: ['estoque'],
        description: 'Entrada de mercadoria: cria lote e recalcula o custo médio.',
        params: IdParams,
        body: ReceiveStockInput,
        response: { 201: StockOperationResult, ...StandardErrors },
      },
    },
    async (request, reply) => {
      const { data, error } = await request.supabase.rpc('receive_stock', {
        p_ingredient_id: request.params.id,
        p_quantity: request.body.quantity,
        p_unit_cost: request.body.unitCost,
        p_expires_at: request.body.expiresAt ?? null,
        p_supplier_id: request.body.supplierId ?? null,
        p_batch_code: request.body.batchCode ?? null,
      })
      if (error) throw app.httpErrors.internalServerError(error.message)

      const result = data as { ok: boolean; error: string | null; batchId: string | null; stockQuantity: number; averageCost: number }
      if (!result.ok) {
        const mapped = mapStockError(result.error ?? 'desconhecido')
        throw app.httpErrors.createError(mapped.status, mapped.message)
      }

      return reply.status(201).send({
        batchId: result.batchId,
        stockQuantity: Number(result.stockQuantity),
        averageCost: Number(result.averageCost),
      })
    },
  )

  app.post(
    '/ingredients/:id/consume',
    {
      onRequest: app.requirePermission('inventory.write'),
      schema: {
        tags: ['estoque'],
        description: 'Baixa manual de estoque (produção, perda ou ajuste), em ordem FEFO/FIFO.',
        params: IdParams,
        body: ConsumeStockInput,
        response: { 200: ConsumeResult, ...StandardErrors },
      },
    },
    async (request) => {
      const { data, error } = await request.supabase.rpc('consume_stock', {
        p_ingredient_id: request.params.id,
        p_quantity: request.body.quantity,
        p_type: request.body.type ?? 'out',
        p_reason: request.body.reason ?? null,
        p_order_id: null,
      })
      if (error) throw app.httpErrors.internalServerError(error.message)

      const result = data as { ok: boolean; error: string | null; consumed: number; stockQuantity: number }
      // Estoque insuficiente não é falha de requisição: o que havia foi baixado
      // e a tela precisa mostrar quanto faltou.
      if (!result.ok && result.error !== 'estoque_insuficiente') {
        const mapped = mapStockError(result.error ?? 'desconhecido')
        throw app.httpErrors.createError(mapped.status, mapped.message)
      }

      return {
        consumed: Number(result.consumed),
        stockQuantity: Number(result.stockQuantity),
        shortage: result.error === 'estoque_insuficiente',
      }
    },
  )

  app.get(
    '/ingredients/:id/movements',
    {
      onRequest: app.requirePermission('inventory.read'),
      schema: {
        tags: ['estoque'],
        description: 'Extrato de movimentações do insumo.',
        params: IdParams,
        response: { 200: Type.Array(StockMovement), ...StandardErrors },
      },
    },
    async (request) => {
      const { data, error } = await request.supabase
        .from('stock_movements')
        .select('id, type, quantity, unit_cost, reason, created_at')
        .eq('ingredient_id', request.params.id)
        .order('created_at', { ascending: false })
        .limit(100)

      if (error) throw app.httpErrors.internalServerError(error.message)

      return (data ?? []).map((row: Record<string, unknown>) => ({
        id: String(row.id),
        type: row.type as never,
        quantity: Number(row.quantity),
        unitCost: Number(row.unit_cost),
        reason: (row.reason as string | null) ?? null,
        createdAt: String(row.created_at),
      }))
    },
  )

  app.patch(
    '/ingredients/:id',
    {
      onRequest: app.requirePermission('inventory.write'),
      schema: {
        tags: ['estoque'],
        description: 'Atualiza um insumo. O estoque só muda por movimentação.',
        params: IdParams,
        body: Type.Partial(IngredientInput),
        response: { 200: Ingredient, ...StandardErrors },
      },
    },
    async (request) => {
      const { baseUnit, minimumStock, isPerishable, shelfLifeDays, isActive, ...rest } = request.body
      const patch: Record<string, unknown> = { ...rest }
      if (baseUnit !== undefined) patch.base_unit = baseUnit
      if (minimumStock !== undefined) patch.minimum_stock = minimumStock
      if (isPerishable !== undefined) patch.is_perishable = isPerishable
      if (shelfLifeDays !== undefined) patch.shelf_life_days = shelfLifeDays
      if (isActive !== undefined) patch.is_active = isActive

      const { data, error } = await request.supabase
        .from('ingredients')
        .update(patch)
        .eq('id', request.params.id)
        .select(INGREDIENT_COLUMNS)
        .maybeSingle()

      if (error) throw app.httpErrors.badRequest(error.message)
      if (!data) throw app.httpErrors.notFound('Insumo não encontrado')
      return toIngredient(data)
    },
  )
}

export default inventoryRoutes
