import type { MenuOptionGroup, MenuProduct } from './types.js'
import { round2 } from '../contracts/money.js'

/** Escolha do cliente: ids das opções marcadas, por grupo. */
export type OptionSelection = Record<string, string[]>

export interface SelectedOptionSnapshot {
  groupId: string
  groupName: string
  optionId: string
  optionName: string
  priceDelta: number
}

export interface SelectionError {
  groupId: string
  groupName: string
  message: string
}

/**
 * Contrato: (product, selection) -> SelectionError[]
 * Valida as regras de min/max de cada grupo de opcionais e a disponibilidade
 * das opções. Array vazio significa seleção válida.
 *
 * Usado no frontend (habilitar o botão) e no backend (revalidar no checkout —
 * nunca confiar no cliente).
 */
export function validateSelection(
  product: MenuProduct,
  selection: OptionSelection,
): SelectionError[] {
  const errors: SelectionError[] = []

  for (const group of product.optionGroups) {
    const chosen = selection[group.id] ?? []
    const valid = chosen.filter((optionId) =>
      group.options.some((option) => option.id === optionId && option.isAvailable),
    )

    if (valid.length !== chosen.length) {
      errors.push({
        groupId: group.id,
        groupName: group.name,
        message: 'Há opções indisponíveis ou inexistentes selecionadas.',
      })
      continue
    }
    if (new Set(chosen).size !== chosen.length) {
      errors.push({ groupId: group.id, groupName: group.name, message: 'Opção repetida.' })
      continue
    }
    if (valid.length < group.minSelect) {
      errors.push({
        groupId: group.id,
        groupName: group.name,
        message: `Escolha ao menos ${group.minSelect} opção(ões) em "${group.name}".`,
      })
      continue
    }
    if (valid.length > group.maxSelect) {
      errors.push({
        groupId: group.id,
        groupName: group.name,
        message: `Escolha no máximo ${group.maxSelect} opção(ões) em "${group.name}".`,
      })
    }
  }

  // Grupos desconhecidos na seleção indicam payload adulterado.
  for (const groupId of Object.keys(selection)) {
    if (!product.optionGroups.some((group: MenuOptionGroup) => group.id === groupId)) {
      errors.push({
        groupId,
        groupName: groupId,
        message: 'Grupo de opcionais não pertence a este produto.',
      })
    }
  }

  return errors
}

/**
 * Contrato: (product, selection) -> SelectedOptionSnapshot[]
 * Congela nome e preço das opções escolhidas — é o que vai para
 * order_items.selected_options e não muda se o cardápio for editado depois.
 */
export function snapshotSelection(
  product: MenuProduct,
  selection: OptionSelection,
): SelectedOptionSnapshot[] {
  const snapshots: SelectedOptionSnapshot[] = []
  for (const group of product.optionGroups) {
    for (const optionId of selection[group.id] ?? []) {
      const option = group.options.find((candidate) => candidate.id === optionId)
      if (!option) continue
      snapshots.push({
        groupId: group.id,
        groupName: group.name,
        optionId: option.id,
        optionName: option.name,
        priceDelta: option.priceDelta,
      })
    }
  }
  return snapshots
}

/**
 * Contrato: (product, selection) -> number
 * Preço unitário = preço base + soma dos acréscimos das opções escolhidas.
 */
export function calculateUnitPrice(product: MenuProduct, selection: OptionSelection): number {
  const extras = snapshotSelection(product, selection).reduce(
    (total, option) => total + option.priceDelta,
    0,
  )
  return round2(product.price + extras)
}

/** Contrato: (product, selection, quantity) -> number — total da linha. */
export function calculateLineTotal(
  product: MenuProduct,
  selection: OptionSelection,
  quantity: number,
): number {
  return round2(calculateUnitPrice(product, selection) * quantity)
}
