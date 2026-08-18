import type {
  CreatePaymentInput,
  CreatePaymentResult,
  FetchLike,
  PaymentIntentStatus,
  PaymentProvider,
  WebhookVerification,
} from './types.js'
import { PaymentProviderError } from './types.js'
import { hmacSha256Hex, isFreshTimestamp, parseSignatureHeader, safeEqual } from './signature.js'

const API_BASE = 'https://api.stripe.com'

const STATUS_MAP: Record<string, PaymentIntentStatus> = {
  requires_payment_method: 'pending',
  requires_confirmation: 'pending',
  requires_action: 'pending',
  processing: 'processing',
  requires_capture: 'processing',
  succeeded: 'approved',
  canceled: 'canceled',
}

/** Contrato: (status) -> PaymentIntentStatus */
export function mapStripeStatus(status: string): PaymentIntentStatus {
  return STATUS_MAP[status] ?? 'pending'
}

/**
 * Contrato: (amount) -> number
 * A Stripe trabalha na menor unidade da moeda: R$ 25,90 vira 2590.
 * Arredonda antes de multiplicar para não herdar erro de ponto flutuante.
 */
export function toStripeAmount(amount: number): number {
  return Math.round(amount * 100)
}

export interface StripeOptions {
  readonly secretKey: string
  readonly webhookSecret: string
  readonly fetchImpl?: FetchLike
  readonly baseUrl?: string
  readonly currency?: string
}

/**
 * Cliente da Stripe (Payment Intents).
 * Referência: POST /v1/payment_intents com corpo form-urlencoded e
 * Idempotency-Key; webhook assinado no cabeçalho Stripe-Signature.
 */
export function createStripeProvider(options: StripeOptions): PaymentProvider {
  const fetchImpl = options.fetchImpl ?? fetch
  const baseUrl = options.baseUrl ?? API_BASE
  const currency = options.currency ?? 'brl'

  return {
    name: 'stripe',

    async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
      const form = new URLSearchParams()
      form.set('amount', String(toStripeAmount(input.amount)))
      form.set('currency', currency)
      form.set('description', input.description)
      form.set('automatic_payment_methods[enabled]', 'true')
      form.set('metadata[order_id]', input.orderId)
      form.set('metadata[order_number]', String(input.orderNumber))
      if (input.payer.email) form.set('receipt_email', input.payer.email)

      const response = await fetchImpl(`${baseUrl}/v1/payment_intents`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
          'idempotency-key': input.idempotencyKey,
        },
        body: form.toString(),
      })

      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null

      if (!response.ok || !payload) {
        throw new PaymentProviderError(
          `Stripe recusou a cobrança (HTTP ${response.status})`,
          response.status,
          payload,
        )
      }

      return {
        providerPaymentId: String(payload.id),
        status: mapStripeStatus(String(payload.status ?? 'requires_payment_method')),
        qrCode: null,
        qrCodeBase64: null,
        // O client_secret é o que o front usa para confirmar o pagamento.
        checkoutUrl: (payload.client_secret as string | undefined) ?? null,
        expiresAt: null,
        raw: payload,
      }
    },

    async verifyWebhook(headers, rawBody): Promise<WebhookVerification> {
      const signature = headers['stripe-signature']
      if (!signature) return { valid: false, reason: 'assinatura ausente' }

      const timestamp = parseSignatureHeader(signature, 't')
      const received = parseSignatureHeader(signature, 'v1')
      if (!timestamp || !received) return { valid: false, reason: 'assinatura malformada' }

      if (!isFreshTimestamp(Number(timestamp))) {
        return { valid: false, reason: 'notificação fora da janela de tolerância' }
      }

      const expected = hmacSha256Hex(options.webhookSecret, `${timestamp}.${rawBody}`)
      if (!safeEqual(expected, received)) {
        return { valid: false, reason: 'assinatura inválida' }
      }

      let event: Record<string, unknown>
      try {
        event = JSON.parse(rawBody) as Record<string, unknown>
      } catch {
        return { valid: false, reason: 'corpo inválido' }
      }

      const data = (event.data ?? {}) as { object?: Record<string, unknown> }
      const object = data.object ?? {}
      const eventType = String(event.type ?? '')

      return {
        valid: true,
        eventId: String(event.id ?? ''),
        eventType,
        providerPaymentId: String(object.id ?? ''),
        status: eventType.endsWith('.refunded')
          ? 'refunded'
          : mapStripeStatus(String(object.status ?? '')),
      }
    },
  }
}
