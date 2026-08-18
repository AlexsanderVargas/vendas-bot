/**
 * Contrato: (productId, options) -> string
 * Identidade estável de uma linha do carrinho: mesmo produto com a mesma
 * combinação de opcionais soma quantidade em vez de criar linha nova.
 * A ordenação torna a chave independente da ordem de clique.
 *
 * Implementação única: o frontend calcula a chave ao montar o carrinho e o
 * backend a revalida na sincronização — as duas pontas precisam concordar.
 */
export function buildLineKey(
  productId: string,
  options: ReadonlyArray<{ optionId: string }>,
): string {
  const ids = options.map((option) => option.optionId).sort()
  return ids.length > 0 ? `${productId}::${ids.join(',')}` : productId
}
