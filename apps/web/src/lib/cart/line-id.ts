import type { SelectedOptionSnapshot } from '@vendas-bot/shared'

/**
 * Contrato: (productId, options) -> string
 * Identidade estável de uma linha do carrinho: mesmo produto com a mesma
 * combinação de opcionais deve somar quantidade, não criar linha nova.
 * A ordenação torna o id independente da ordem de clique.
 */
export function buildLineId(
  productId: string,
  options: readonly SelectedOptionSnapshot[],
): string {
  const ids = options.map((option) => option.optionId).sort()
  return ids.length > 0 ? `${productId}::${ids.join(',')}` : productId
}
