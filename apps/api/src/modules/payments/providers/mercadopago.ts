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

const API_BASE = 'https://api.mercadopago.com'

/** Mapa de status do Mercado Pago para o nosso vocabulário. */
const STATUS_MAP: Record<string, PaymentIntentStatus> = {
  pending: 'pending',
  in_process: 'processing',
  authorized: 'processing',
  approved: 'approved',
  rejected: 'rejected',
  refunded: 'refunded',
  charged_back: 'refunded',
  cancelled: 'canceled',
}

/** Contrato: (status) -> PaymentIntentStatus */
export function mapMercadoPagoStatus(status: string): PaymentIntentStatus {
  return STATUS_MAP[status] ?? 'pending'
}

export interface MercadoPagoOptions {
  readonly accessToken: string
  /** Segredo da assinatura configurado no painel de webhooks. */
  readonly webhookSecret: string
  readonly fetchImpl?: FetchLike
  readonly baseUrl?: string
}

/**
 * Cliente do Mercado Pago (API v1 de pagamentos).
 * Referência: POST /v1/payments com X-Idempotency-Key; PIX devolve o
 * copia-e-cola em point_of_interaction.transaction_data.
 */
export function createMercadoPagoProvider(options: MercadoPagoOptions): PaymentProvider {
  const fetchImpl = options.fetchImpl ?? fetch
  const baseUrl = options.baseUrl ?? API_BASE

  return {
    name: 'mercadopago',

    async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
      const body: Record<string, unknown> = {
        transaction_amount: input.amount,
        description: input.description,
        external_reference: input.orderId,
        payment_method_id: input.method === 'pix' ? 'pix' : undefined,
        payer: {
          email: input.payer.email,
          ...(input.payer.name ? { first_name: input.payer.name } : {}),
          ...(input.payer.document
            ? { identification: { type: input.payer.document.length > 11 ? 'CNPJ' : 'CPF', number: input.payer.document } }
            : {}),
        },
      }

      const response = await fetchImpl(`${baseUrl}/v1/payments`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.accessToken}`,
          'content-type': 'application/json',
          'x-idempotency-key': input.idempotencyKey,
        },
        body: JSON.stringify(body),
      })

      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null

      if (!response.ok || !payload) {
        throw new PaymentProviderError(
          `Mercado Pago recusou a cobrança (HTTP ${response.status})`,
          response.status,
          payload,
        )
      }

      const interaction = payload.point_of_interaction as
        | { transaction_data?: { qr_code?: string; qr_code_base64?: string; ticket_url?: string } }
        | undefined
      const transaction = interaction?.transaction_data

      return {
        providerPaymentId: String(payload.id),
        status: mapMercadoPagoStatus(String(payload.status ?? 'pending')),
        qrCode: transaction?.qr_code ?? null,
        qrCodeBase64: transaction?.qr_code_base64 ?? null,
        checkoutUrl: transaction?.ticket_url ?? null,
        expiresAt: (payload.date_of_expiration as string | undefined) ?? null,
        raw: payload,
      }
    },

    async verifyWebhook(headers, rawBody): Promise<WebhookVerification> {
      const signature = headers['x-signature']
      const requestId = headers['x-request-id'] ?? ''
      if (!signature) return { valid: false, reason: 'assinatura ausente' }

      const timestamp = parseSignatureHeader(signature, 'ts')
      const received = parseSignatureHeader(signature, 'v1')
      if (!timestamp || !received) return { valid: false, reason: 'assinatura malformada' }

      if (!isFreshTimestamp(Number(timestamp))) {
        return { valid: false, reason: 'notificação fora da janela de tolerância' }
      }

      let body: Record<string, unknown>
      try {
        body = JSON.parse(rawBody) as Record<string, unknown>
      } catch {
        return { valid: false, reason: 'corpo inválido' }
      }

      const data = (body.data ?? {}) as { id?: string | number }
      const paymentId = data.id === undefined ? '' : String(data.id)

      // Manifesto exigido pelo Mercado Pago, na ordem documentada.
      const manifest = `id:${paymentId};request-id:${requestId};ts:${timestamp};`
      const expected = hmacSha256Hex(options.webhookSecret, manifest)

      if (!safeEqual(expected, received)) {
        return { valid: false, reason: 'assinatura inválida' }
      }

      return {
        valid: true,
        eventId: `${paymentId}:${body.id ?? timestamp}`,
        eventType: String(body.action ?? body.type ?? 'payment.updated'),
        providerPaymentId: paymentId,
      }
    },
  }
}
