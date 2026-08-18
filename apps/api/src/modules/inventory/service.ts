import type { Ingredient } from './schemas.js'

interface IngredientRow {
  id: string
  name: string
  sku: string | null
  base_unit: Ingredient['baseUnit']
  average_cost: string | number
  stock_quantity: string | number
  minimum_stock: string | number
  is_perishable: boolean
  shelf_life_days: number | null
  is_active: boolean
}

/** Contrato: (row) -> Ingredient — normaliza numéricos e deriva belowMinimum. */
export function toIngredient(row: IngredientRow): Ingredient {
  const stockQuantity = Number(row.stock_quantity)
  const minimumStock = Number(row.minimum_stock)
  return {
    id: row.id,
    name: row.name,
    sku: row.sku,
    baseUnit: row.base_unit,
    averageCost: Number(row.average_cost),
    stockQuantity,
    minimumStock,
    isPerishable: row.is_perishable,
    shelfLifeDays: row.shelf_life_days,
    isActive: row.is_active,
    belowMinimum: stockQuantity <= minimumStock,
  }
}

export const INGREDIENT_COLUMNS =
  'id, name, sku, base_unit, average_cost, stock_quantity, minimum_stock, is_perishable, shelf_life_days, is_active'

interface SupplierRow {
  id: string
  name: string
  document: string | null
  email: string | null
  phone: string | null
  contact_name: string | null
  notes: string | null
  is_active: boolean
}

/** Contrato: (row) -> Supplier */
export function toSupplier(row: SupplierRow) {
  return {
    id: row.id,
    name: row.name,
    document: row.document,
    email: row.email,
    phone: row.phone,
    contactName: row.contact_name,
    notes: row.notes,
    isActive: row.is_active,
  }
}

export const SUPPLIER_COLUMNS = 'id, name, document, email, phone, contact_name, notes, is_active'

const STOCK_ERROR_STATUS: Record<string, number> = {
  insumo_nao_encontrado: 404,
  nao_autorizado: 403,
  validade_obrigatoria: 400,
  quantidade_invalida: 400,
  estoque_insuficiente: 409,
}

const STOCK_ERROR_MESSAGE: Record<string, string> = {
  insumo_nao_encontrado: 'Insumo não encontrado.',
  nao_autorizado: 'Este insumo pertence a outro estabelecimento.',
  validade_obrigatoria: 'Insumo perecível exige a data de validade do lote.',
  quantidade_invalida: 'Informe uma quantidade maior que zero.',
  estoque_insuficiente: 'Estoque insuficiente para a baixa solicitada.',
}

/** Contrato: (error) -> { status, message } */
export function mapStockError(error: string): { status: number; message: string } {
  return {
    status: STOCK_ERROR_STATUS[error] ?? 400,
    message: STOCK_ERROR_MESSAGE[error] ?? 'Não foi possível concluir a operação de estoque.',
  }
}
