import { describe, expect, it } from 'vitest'
import { formatBrPhone, isValidE164, normalizeToE164 } from '@vendas-bot/shared'

describe('normalizeToE164', () => {
  it('normaliza número nacional com DDD e 9 dígitos', () => {
    expect(normalizeToE164('51 99999-0001')).toBe('+5551999990001')
  })
  it('normaliza número nacional de 8 dígitos (fixo)', () => {
    expect(normalizeToE164('(51) 3333-4444')).toBe('+555133334444')
  })
  it('preserva número já internacional', () => {
    expect(normalizeToE164('+55 51 99999-0001')).toBe('+5551999990001')
  })
  it('aceita código do país sem o sinal de mais', () => {
    expect(normalizeToE164('5551999990001')).toBe('+5551999990001')
  })
  it('aceita outro país quando informado com +', () => {
    expect(normalizeToE164('+1 415 555 2671')).toBe('+14155552671')
  })
  it('rejeita número curto demais', () => {
    expect(normalizeToE164('99999')).toBeNull()
  })
  it('rejeita entrada vazia ou sem dígitos', () => {
    expect(normalizeToE164('   ')).toBeNull()
    expect(normalizeToE164('abc')).toBeNull()
  })
  it('rejeita número nacional sem DDD', () => {
    expect(normalizeToE164('99999-0001')).toBeNull()
  })
})

describe('isValidE164', () => {
  it('aceita formato do CHECK do banco', () => {
    expect(isValidE164('+5551999990001')).toBe(true)
  })
  it('rejeita sem o prefixo +', () => {
    expect(isValidE164('5551999990001')).toBe(false)
  })
  it('rejeita com separadores', () => {
    expect(isValidE164('+55 51 99999-0001')).toBe(false)
  })
})

describe('formatBrPhone', () => {
  it('formata celular brasileiro', () => {
    expect(formatBrPhone('+5551999990001')).toBe('(51) 99999-0001')
  })
  it('devolve o original quando não é BR', () => {
    expect(formatBrPhone('+14155552671')).toBe('+14155552671')
  })
})
