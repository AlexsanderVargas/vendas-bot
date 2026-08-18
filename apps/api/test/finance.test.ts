import { describe, expect, it } from 'vitest'
import { mapFinanceError, toAccount } from '../src/modules/finance/routes.js'

describe('toAccount', () => {
  it('normaliza numéricos e deriva o saldo devedor', () => {
    const account = toAccount({
      id: 'acc-1', direction: 'payable', status: 'partially_paid',
      description: 'Compra de insumos (1/3)', amount: '33.34', paid_amount: '10.00',
      due_date: '2026-08-18', paid_at: null, installment: 1, installments: 3,
      supplier_id: 'sup-1', category_id: 'cat-1',
    })
    expect(account.amount).toBe(33.34)
    expect(account.paidAmount).toBe(10)
    expect(account.remaining).toBe(23.34)
  })

  it('zera o saldo quando o título está quitado', () => {
    const account = toAccount({
      id: 'acc-2', direction: 'receivable', status: 'paid',
      description: 'Venda', amount: '100.00', paid_amount: '100.00',
      due_date: '2026-08-18', paid_at: '2026-08-18T12:00:00Z',
      installment: 1, installments: 1, supplier_id: null, category_id: null,
    })
    expect(account.remaining).toBe(0)
  })

  it('arredonda o saldo evitando erro de ponto flutuante', () => {
    const account = toAccount({
      id: 'acc-3', direction: 'payable', status: 'partially_paid',
      description: 'Parcial', amount: '0.30', paid_amount: '0.10',
      due_date: '2026-08-18', paid_at: null, installment: 1, installments: 1,
      supplier_id: null, category_id: null,
    })
    expect(account.remaining).toBe(0.2)
  })
})

describe('mapFinanceError', () => {
  it('mapeia título inexistente para 404', () => {
    expect(mapFinanceError('conta_nao_encontrada').status).toBe(404)
  })
  it('mapeia título de outro tenant para 403', () => {
    expect(mapFinanceError('nao_autorizado').status).toBe(403)
  })
  it('mapeia título cancelado para 409', () => {
    expect(mapFinanceError('conta_cancelada').status).toBe(409)
  })
  it('mapeia valor inválido para 400', () => {
    expect(mapFinanceError('valor_invalido').status).toBe(400)
  })
})
