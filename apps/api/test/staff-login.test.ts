import { describe, expect, it } from 'vitest'
import {
  isEmailIdentifier,
  normalizeStaffLogin,
  resolveStaffEmail,
  staffLoginEmail,
} from '@vendas-bot/shared'

describe('identidade de acesso da equipe', () => {
  it('normaliza para minúsculas', () => {
    expect(normalizeStaffLogin('  Caixa1 ')).toBe('caixa1')
  })

  it('aceita ponto, hífen e sublinhado', () => {
    expect(normalizeStaffLogin('maria.silva')).toBe('maria.silva')
    expect(normalizeStaffLogin('joao_2')).toBe('joao_2')
    expect(normalizeStaffLogin('ana-p')).toBe('ana-p')
  })

  it('recusa o que não serve como identificador', () => {
    expect(normalizeStaffLogin('ab')).toBeNull() // curto demais
    expect(normalizeStaffLogin('1caixa')).toBeNull() // começa com número
    expect(normalizeStaffLogin('caixa 1')).toBeNull() // espaço
    expect(normalizeStaffLogin('joão')).toBeNull() // acento não sobrevive a URL/e-mail
    expect(normalizeStaffLogin('a'.repeat(31))).toBeNull()
  })

  it('distingue e-mail de nome de usuário pela arroba', () => {
    expect(isEmailIdentifier('maria@lancheria.com')).toBe(true)
    expect(isEmailIdentifier('maria')).toBe(false)
  })

  it('deriva o endereço técnico do usuário e do slug', () => {
    expect(staffLoginEmail('caixa1', 'lancheria-demo')).toBe(
      'caixa1@lancheria-demo.equipe.gastrosync.app',
    )
  })

  it('mesmo usuário em lojas diferentes são contas diferentes', () => {
    expect(staffLoginEmail('caixa1', 'loja-a')).not.toBe(staffLoginEmail('caixa1', 'loja-b'))
  })

  it('resolve o que a pessoa digita na tela de entrada', () => {
    expect(resolveStaffEmail('Maria@Lancheria.com', 'lancheria-demo')).toBe('maria@lancheria.com')
    expect(resolveStaffEmail('Caixa1', 'lancheria-demo')).toBe(
      'caixa1@lancheria-demo.equipe.gastrosync.app',
    )
    expect(resolveStaffEmail('caixa 1', 'lancheria-demo')).toBeNull()
  })
})
