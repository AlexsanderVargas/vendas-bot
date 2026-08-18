/** Formatação monetária compartilhada entre as telas B2C e o painel interno. */

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })

/** Contrato: (value) -> string — ex.: 25.9 -> "R$ 25,90". */
export function formatBRL(value: number): string {
  return BRL.format(value)
}

/**
 * Contrato: (value) -> number — arredonda para 2 casas evitando o erro de
 * ponto flutuante de (0.1 + 0.2). Todo total exibido/gravado passa por aqui.
 */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}
