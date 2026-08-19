/**
 * Validação de CPF e CNPJ — mesma regra usada pelo formulário do checkout e
 * pela persistência, para que o cliente nunca receba do servidor uma recusa
 * que o formulário deixou passar.
 *
 * O dígito verificador é calculado, não só o formato: CPF de 11 dígitos
 * iguais (111.111.111-11) tem forma válida e é inválido de fato, e é
 * justamente o que alguém digita para "pular" o campo.
 */

/** Contrato: (input) -> string — mantém apenas os dígitos. */
export function onlyDigits(input: string): string {
  return input.replace(/\D/g, '')
}

/** Contrato: (digits, weights) -> number — dígito verificador pelo módulo 11. */
function checkDigit(digits: string, weights: readonly number[]): number {
  const sum = weights.reduce((total, weight, index) => total + Number(digits[index]) * weight, 0)
  const remainder = sum % 11
  return remainder < 2 ? 0 : 11 - remainder
}

const CPF_WEIGHTS_1 = [10, 9, 8, 7, 6, 5, 4, 3, 2] as const
const CPF_WEIGHTS_2 = [11, 10, 9, 8, 7, 6, 5, 4, 3, 2] as const
const CNPJ_WEIGHTS_1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] as const
const CNPJ_WEIGHTS_2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] as const

/** Contrato: (input) -> boolean — CPF com 11 dígitos e verificadores corretos. */
export function isValidCpf(input: string): boolean {
  const digits = onlyDigits(input)
  if (digits.length !== 11) return false
  if (/^(\d)\1{10}$/.test(digits)) return false

  return (
    checkDigit(digits, CPF_WEIGHTS_1) === Number(digits[9]) &&
    checkDigit(digits, CPF_WEIGHTS_2) === Number(digits[10])
  )
}

/** Contrato: (input) -> boolean — CNPJ com 14 dígitos e verificadores corretos. */
export function isValidCnpj(input: string): boolean {
  const digits = onlyDigits(input)
  if (digits.length !== 14) return false
  if (/^(\d)\1{13}$/.test(digits)) return false

  return (
    checkDigit(digits, CNPJ_WEIGHTS_1) === Number(digits[12]) &&
    checkDigit(digits, CNPJ_WEIGHTS_2) === Number(digits[13])
  )
}

/**
 * Contrato: (input) -> string | null
 * Devolve o documento só com dígitos quando é um CPF ou CNPJ válido; null
 * quando não é. É o formato guardado no banco (check `customers_document_digits`).
 */
export function normalizeDocument(input: string): string | null {
  const digits = onlyDigits(input)
  if (isValidCpf(digits) || isValidCnpj(digits)) return digits
  return null
}

/** Contrato: (input) -> string — máscara de exibição; devolve a entrada se não reconhecer. */
export function formatDocument(input: string): string {
  const digits = onlyDigits(input)
  if (digits.length === 11) {
    return digits.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4')
  }
  if (digits.length === 14) {
    return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
  }
  return input
}
