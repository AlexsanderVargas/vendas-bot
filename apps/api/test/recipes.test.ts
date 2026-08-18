import { describe, expect, it } from 'vitest'
import { effectiveQuantity } from '../src/modules/recipes/routes.js'

describe('effectiveQuantity (espelho de recipe_effective_quantity)', () => {
  it('sem perda devolve a própria quantidade', () => {
    expect(effectiveQuantity(100, 0)).toBe(100)
  })
  it('embute a perda de preparo', () => {
    expect(effectiveQuantity(150, 10)).toBe(166.6667)
  })
  it('perda de 50% dobra o consumo', () => {
    expect(effectiveQuantity(100, 50)).toBe(200)
  })
  it('arredonda em 4 casas, como a coluna numeric(14,4)', () => {
    expect(effectiveQuantity(1, 3)).toBe(1.0309)
  })
})
