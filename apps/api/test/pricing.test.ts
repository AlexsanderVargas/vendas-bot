import { describe, expect, it } from 'vitest'
import type { MenuProduct } from '@vendas-bot/shared'
import {
  calculateLineTotal,
  calculateUnitPrice,
  snapshotSelection,
  validateSelection,
} from '@vendas-bot/shared'

const PRODUTO: MenuProduct = {
  id: 'prod-1',
  name: 'X-Salada',
  description: null,
  price: 25.9,
  imageUrl: null,
  isAvailable: true,
  optionGroups: [
    {
      id: 'grp-ponto',
      name: 'Ponto da carne',
      selectionType: 'single',
      minSelect: 1,
      maxSelect: 1,
      options: [
        { id: 'opt-ao-ponto', name: 'Ao ponto', priceDelta: 0, isAvailable: true },
        { id: 'opt-bem', name: 'Bem passada', priceDelta: 2.5, isAvailable: true },
        { id: 'opt-mal', name: 'Mal passada', priceDelta: 0, isAvailable: false },
      ],
    },
    {
      id: 'grp-add',
      name: 'Adicionais',
      selectionType: 'multiple',
      minSelect: 0,
      maxSelect: 2,
      options: [
        { id: 'opt-bacon', name: 'Bacon', priceDelta: 4.5, isAvailable: true },
        { id: 'opt-queijo', name: 'Queijo extra', priceDelta: 3.25, isAvailable: true },
        { id: 'opt-ovo', name: 'Ovo', priceDelta: 2, isAvailable: true },
      ],
    },
  ],
}

describe('validateSelection', () => {
  it('aceita seleção que respeita min e max', () => {
    expect(validateSelection(PRODUTO, { 'grp-ponto': ['opt-ao-ponto'] })).toEqual([])
  })
  it('exige o mínimo do grupo obrigatório', () => {
    const erros = validateSelection(PRODUTO, {})
    expect(erros).toHaveLength(1)
    expect(erros[0]!.groupId).toBe('grp-ponto')
    expect(erros[0]!.message).toContain('ao menos 1')
  })
  it('recusa mais escolhas que o máximo', () => {
    const erros = validateSelection(PRODUTO, {
      'grp-ponto': ['opt-ao-ponto'],
      'grp-add': ['opt-bacon', 'opt-queijo', 'opt-ovo'],
    })
    expect(erros).toHaveLength(1)
    expect(erros[0]!.message).toContain('no máximo 2')
  })
  it('recusa opção indisponível', () => {
    const erros = validateSelection(PRODUTO, { 'grp-ponto': ['opt-mal'] })
    expect(erros[0]!.message).toContain('indisponíveis')
  })
  it('recusa opção inexistente (payload adulterado)', () => {
    const erros = validateSelection(PRODUTO, { 'grp-ponto': ['opt-inventada'] })
    expect(erros).toHaveLength(1)
  })
  it('recusa opção repetida', () => {
    const erros = validateSelection(PRODUTO, { 'grp-ponto': ['opt-ao-ponto', 'opt-ao-ponto'] })
    expect(erros[0]!.message).toBe('Opção repetida.')
  })
  it('recusa grupo que não pertence ao produto', () => {
    const erros = validateSelection(PRODUTO, {
      'grp-ponto': ['opt-ao-ponto'],
      'grp-alheio': ['x'],
    })
    expect(erros).toHaveLength(1)
    expect(erros[0]!.message).toContain('não pertence')
  })
})

describe('calculateUnitPrice', () => {
  it('usa o preço base quando não há acréscimo', () => {
    expect(calculateUnitPrice(PRODUTO, { 'grp-ponto': ['opt-ao-ponto'] })).toBe(25.9)
  })
  it('soma os acréscimos das opções escolhidas', () => {
    expect(
      calculateUnitPrice(PRODUTO, { 'grp-ponto': ['opt-bem'], 'grp-add': ['opt-bacon'] }),
    ).toBe(32.9)
  })
  it('arredonda evitando erro de ponto flutuante', () => {
    expect(calculateUnitPrice(PRODUTO, { 'grp-add': ['opt-queijo', 'opt-ovo'] })).toBe(31.15)
  })
  it('ignora opção inexistente no cálculo', () => {
    expect(calculateUnitPrice(PRODUTO, { 'grp-add': ['opt-fantasma'] })).toBe(25.9)
  })
})

describe('calculateLineTotal', () => {
  it('multiplica pelo quantitativo', () => {
    expect(calculateLineTotal(PRODUTO, { 'grp-add': ['opt-bacon'] }, 3)).toBe(91.2)
  })
})

describe('snapshotSelection', () => {
  it('congela nome e preço das opções na ordem dos grupos', () => {
    const snapshot = snapshotSelection(PRODUTO, {
      'grp-add': ['opt-bacon'],
      'grp-ponto': ['opt-bem'],
    })
    expect(snapshot).toEqual([
      { groupId: 'grp-ponto', groupName: 'Ponto da carne', optionId: 'opt-bem', optionName: 'Bem passada', priceDelta: 2.5 },
      { groupId: 'grp-add', groupName: 'Adicionais', optionId: 'opt-bacon', optionName: 'Bacon', priceDelta: 4.5 },
    ])
  })
})
