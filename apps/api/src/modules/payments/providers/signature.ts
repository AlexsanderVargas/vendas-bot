import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Contrato: (secret, payload) -> string
 * HMAC-SHA256 em hexadecimal, formato usado por Mercado Pago e Stripe.
 */
export function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

/**
 * Contrato: (a, b) -> boolean
 * Comparação em tempo constante. Comparar assinaturas com === vaza, pelo
 * tempo de resposta, quantos caracteres iniciais o atacante acertou.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8')
  const bufferB = Buffer.from(b, 'utf8')
  if (bufferA.length !== bufferB.length) return false
  return timingSafeEqual(bufferA, bufferB)
}

/**
 * Contrato: (header, key) -> string | null
 * Extrai um campo de cabeçalhos no formato "ts=123,v1=abc" (Mercado Pago) ou
 * "t=123,v1=abc" (Stripe).
 */
export function parseSignatureHeader(header: string, key: string): string | null {
  for (const part of header.split(',')) {
    const [name, value] = part.split('=')
    if (name?.trim() === key) return value?.trim() ?? null
  }
  return null
}

/**
 * Contrato: (timestamp, toleranceSeconds, now?) -> boolean
 * Rejeita notificações antigas: sem isso, uma requisição capturada poderia
 * ser reenviada indefinidamente com assinatura ainda válida.
 */
export function isFreshTimestamp(
  timestamp: number,
  toleranceSeconds = 300,
  now: number = Date.now(),
): boolean {
  const ageSeconds = Math.abs(now / 1000 - timestamp)
  return ageSeconds <= toleranceSeconds
}
