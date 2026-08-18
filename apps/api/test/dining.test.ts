import { describe, expect, it } from 'vitest'
import { canTransitionTable } from '../src/modules/dining/routes.js'

describe('canTransitionTable (espelho de can_transition_table)', () => {
  it('livre pode ser ocupada ou reservada', () => {
    expect(canTransitionTable('free', 'occupied')).toBe(true)
    expect(canTransitionTable('free', 'reserved')).toBe(true)
  })
  it('ocupada não volta direto para livre', () => {
    expect(canTransitionTable('occupied', 'free')).toBe(false)
  })
  it('ciclo de atendimento é permitido', () => {
    expect(canTransitionTable('occupied', 'billing')).toBe(true)
    expect(canTransitionTable('billing', 'cleaning')).toBe(true)
    expect(canTransitionTable('cleaning', 'free')).toBe(true)
  })
  it('conta pode ser reaberta enquanto a mesa não é liberada', () => {
    expect(canTransitionTable('billing', 'occupied')).toBe(true)
  })
  it('mesa livre não fecha conta', () => {
    expect(canTransitionTable('free', 'billing')).toBe(false)
  })
  it('manutenção entra e sai a qualquer momento', () => {
    expect(canTransitionTable('occupied', 'inactive')).toBe(true)
    expect(canTransitionTable('inactive', 'free')).toBe(true)
  })
  it('mesmo status é sempre aceito (idempotência)', () => {
    expect(canTransitionTable('occupied', 'occupied')).toBe(true)
  })
})

describe('mapComandaError', () => {
  it('mapeia mesa já com comanda para 409', async () => {
    const { mapComandaError } = await import('../src/modules/dining/routes.js')
    const mapped = mapComandaError('comanda_ja_aberta')
    expect(mapped.status).toBe(409)
    expect(mapped.message).toContain('já tem uma comanda')
  })
  it('mapeia mesa de outro estabelecimento para 403', async () => {
    const { mapComandaError } = await import('../src/modules/dining/routes.js')
    expect(mapComandaError('nao_autorizado').status).toBe(403)
  })
  it('mapeia comanda encerrada para 409', async () => {
    const { mapComandaError } = await import('../src/modules/dining/routes.js')
    expect(mapComandaError('pedido_fechado').status).toBe(409)
  })
  it('mapeia opcional obrigatório para 400', async () => {
    const { mapComandaError } = await import('../src/modules/dining/routes.js')
    expect(mapComandaError('opcionais_obrigatorios').status).toBe(400)
  })
  it('usa mensagem genérica para erro desconhecido', async () => {
    const { mapComandaError } = await import('../src/modules/dining/routes.js')
    expect(mapComandaError('novo_erro').status).toBe(400)
  })
})
