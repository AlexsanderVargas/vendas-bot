/**
 * Normalização de telefone para E.164 — mesmo formato exigido pelo check
 * `customers_whatsapp_e164` no banco. Usado pelo frontend (formulário de
 * cadastro progressivo) e pelo backend (persistência), para que a validação
 * seja idêntica dos dois lados.
 */

const DEFAULT_COUNTRY_CODE = '55'

/** Contrato: (input, countryCode?) -> string | null. Null quando inválido. */
export function normalizeToE164(
  input: string,
  countryCode: string = DEFAULT_COUNTRY_CODE,
): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  const hadPlus = trimmed.startsWith('+')
  const digits = trimmed.replace(/\D/g, '')
  if (!digits) return null

  // Já veio internacional (+55 51 ...) ou com o código do país na frente.
  let full: string
  if (hadPlus) {
    full = digits
  } else if (digits.length > 11 && digits.startsWith(countryCode)) {
    full = digits
  } else {
    // Número nacional: precisa de DDD (2) + assinante (8 ou 9).
    if (digits.length < 10 || digits.length > 11) return null
    full = `${countryCode}${digits}`
  }

  const candidate = `+${full}`
  return isValidE164(candidate) ? candidate : null
}

/** Contrato: (value) -> boolean. Espelha o CHECK do banco. */
export function isValidE164(value: string): boolean {
  return /^\+[1-9][0-9]{7,14}$/.test(value)
}

/** Contrato: (e164) -> string — formatação amigável para exibição no Brasil. */
export function formatBrPhone(e164: string): string {
  const match = /^\+55(\d{2})(\d{4,5})(\d{4})$/.exec(e164)
  if (!match) return e164
  return `(${match[1]}) ${match[2]}-${match[3]}`
}
