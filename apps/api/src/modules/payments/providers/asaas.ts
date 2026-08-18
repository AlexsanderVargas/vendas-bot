import type {
  CreatePaymentInput,
  CreatePaymentResult,
  FetchLike,
  PaymentIntentStatus,
  PaymentProvider,
  WebhookVerification,
} from './types.js'
import { PaymentProviderError } from './types.js'
import { safeEqual } from './signature.js'

const API_BASE = 'https://api.asaas.com'

const STATUS_MAP: Record<string, PaymentIntentStatus> = {
  PENDING: 'pending',
  AWAITING_RISK_ANALYSIS: 'processing',
  RECEIVED: 'approved',
  CONFIRMED: 'approved',
  RECEIVED_IN_CASH: 'approved',
  OVERDUE: 'expired',
  REFUNDED: 'refunded',
  REFUND_REQUESTED: 'refunded',
  CHARGEBACK_REQUESTED: 'refunded',
  PAYMENT_DELETED: 'canceled',
}

/** Contrato: (status) -> PaymentIntentStatus */
export function mapAsaasStatus(status: string): PaymentIntentStatus {
  return STATUS_MAP[status] ?? 'pending'
}

const BILLING_TYPE: Record<CreatePaymentInput['method'], string> = {
  pix: 'PIX',
  credit_card: 'CREDIT_CARD',
  debit_card: 'DEBIT_CARD',
  boleto: 'BOLETO',
}

/** Contrato: (date) -> string — vencimento no formato YYYY-MM-DD exigido pelo Asaas. */
export function toAsaasDueDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export interface AsaasOptions {
  readonly apiKey: string
  /** Token conferido no cabeçalho asaas-access-token das notificações. */
  readonly webhookToken: string
  readonly fetchImpl?: FetchLike
  readonly baseUrl?: string
  /** Dias até o vencimento da cobrança. */
  readonly dueInDays?: number
  readonly now?: () => Date
}

/**
 * Cliente do Asaas (API v3).
 * Referência: POST /v3/payments autenticado pelo cabeçalho access_token; o
 * copia-e-cola do PIX vem de GET /v3/payments/{id}/pixQrCode.
 */
export function createAsaasProvider(options: AsaasOptions): PaymentProvider {
  const fetchImpl = options.fetchImpl ?? fetch
  const baseUrl = options.baseUrl ?? API_BASE
  const now = options.now ?? (() => new Date())

  return {
    name: 'asaas',

    async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
      if (!input.providerCustomerId) {
        throw new PaymentProviderError(
          'Asaas exige o identificador do cliente (customer) para cobrar',
          400,
        )
      }

      const dueDate = new Date(now().getTime() + (options.dueInDays ?? 1) * 86_400_000)

      const response = await fetchImpl(`${baseUrl}/v3/payments`, {
        method: 'POST',
        headers: {
          access_token: options.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          customer: input.providerCustomerId,
          billingType: BILLING_TYPE[input.method],
          value: input.amount,
          dueDate: toAsaasDueDate(dueDate),
          description: input.description,
          externalReference: input.orderId,
        }),
      })

      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null

      if (!response.ok || !payload) {
        throw new PaymentProviderError(
          `Asaas recusou a cobrança (HTTP ${response.status})`,
          response.status,
          payload,
        )
      }

      const paymentId = String(payload.id)
      let qrCode: string | null = null
      let qrCodeBase64: string | null = null

      // O QR do PIX vem em um segundo endpoint.
      if (input.method === 'pix') {
        const qrResponse = await fetchImpl(`${baseUrl}/v3/payments/${paymentId}/pixQrCode`, {
          method: 'GET',
          headers: { access_token: options.apiKey },
        })
        if (qrResponse.ok) {
          const qrPayload = (await qrResponse.json().catch(() => null)) as
            | { payload?: string; encodedImage?: string }
            | null
          qrCode = qrPayload?.payload ?? null
          qrCodeBase64 = qrPayload?.encodedImage ?? null
        }
      }

      return {
        providerPaymentId: paymentId,
        status: mapAsaasStatus(String(payload.status ?? 'PENDING')),
        qrCode,
        qrCodeBase64,
        checkoutUrl: (payload.invoiceUrl as string | undefined) ?? null,
        expiresAt: (payload.dueDate as string | undefined) ?? null,
        raw: payload,
      }
    },

    async verifyWebhook(headers, rawBody): Promise<WebhookVerification> {
      // O Asaas não assina o corpo: autentica por token fixo no cabeçalho.
      const token = headers['asaas-access-token']
      if (!token) return { valid: false, reason: 'token ausente' }
      if (!safeEqual(token, options.webhookToken)) {
        return { valid: false, reason: 'token inválido' }
      }

      let event: Record<string, unknown>
      try {
        event = JSON.parse(rawBody) as Record<string, unknown>
      } catch {
        return { valid: false, reason: 'corpo inválido' }
      }

      const payment = (event.payment ?? {}) as { id?: string; status?: string }

      return {
        valid: true,
        eventId: String(event.id ?? `${payment.id}:${event.event}`),
        eventType: String(event.event ?? 'PAYMENT_UPDATED'),
        providerPaymentId: payment.id ? String(payment.id) : undefined,
        status: payment.status ? mapAsaasStatus(payment.status) : undefined,
      }
    },
  }
}
