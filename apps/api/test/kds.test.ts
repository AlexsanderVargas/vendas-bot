import { describe, expect, it } from 'vitest'
import { canTransitionPrep } from '../src/modules/kds/routes.js'

describe('canTransitionPrep (espelho de can_transition_prep)', () => {
  it('pendente pode ir direto a pronto (item simples)', () => {
    expect(canTransitionPrep('pending', 'ready')).toBe(true)
  })
  it('pendente pode entrar em preparo', () => {
    expect(canTransitionPrep('pending', 'preparing')).toBe(true)
  })
  it('em preparo não volta para pendente', () => {
    expect(canTransitionPrep('preparing', 'pending')).toBe(false)
  })
  it('pronto pode voltar ao fogo se esfriou', () => {
    expect(canTransitionPrep('ready', 'preparing')).toBe(true)
  })
  it('pronto pode ser servido', () => {
    expect(canTransitionPrep('ready', 'served')).toBe(true)
  })
  it('servido é estado final', () => {
    expect(canTransitionPrep('served', 'preparing')).toBe(false)
    expect(canTransitionPrep('served', 'ready')).toBe(false)
  })
  it('cancelado é estado final', () => {
    expect(canTransitionPrep('canceled', 'preparing')).toBe(false)
  })
})
