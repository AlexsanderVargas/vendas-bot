/**
 * Porta comum dos provedores de pagamento.
 *
 * IMPORTANTE: os clientes concretos foram escritos a partir da documentação
 * oficial de cada gateway, mas NÃO foram exercitados contra os ambientes
 * reais — não há credenciais nesta base. Os testes cobrem o formato das
 * requisições, o mapeamento de status e a verificação de assinatura com
 * transporte HTTP mockado. Antes de produção, homologar em sandbox.
 */

export type PaymentIntentStatus =
  | 'pending'
  | 'processing'
  | 'approved'
  | 'rejected'
  | 'refunded'
  | 'canceled'
  | 'expired'

export type PaymentMethod = 'pix' | 'credit_card' | 'debit_card' | 'boleto'

export interface CreatePaymentInput {
  /** Valor em reais, com 2 casas. */
  readonly amount: number
  readonly method: PaymentMethod
  readonly description: string
  readonly orderId: string
  readonly orderNumber: number
  readonly payer: {
    readonly email: string
    readonly name?: string | null
    readonly document?: string | null
  }
  /** Chave de idempotência para não duplicar cobrança em retry de rede. */
  readonly idempotencyKey: string
  /** Referência do cliente no provedor, quando o provedor exigir (Asaas). */
  readonly providerCustomerId?: string | null
}

export interface CreatePaymentResult {
  readonly providerPaymentId: string
  readonly status: PaymentIntentStatus
  /** PIX Copia e Cola. */
  readonly qrCode: string | null
  readonly qrCodeBase64: string | null
  readonly checkoutUrl: string | null
  readonly expiresAt: string | null
  readonly raw: unknown
}

export interface WebhookVerification {
  readonly valid: boolean
  readonly reason?: string
  readonly eventId?: string
  readonly eventType?: string
  readonly providerPaymentId?: string
  readonly status?: PaymentIntentStatus
}

export interface PaymentProvider {
  readonly name: 'mercadopago' | 'stripe' | 'asaas'
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>
  /**
   * Contrato: (headers, rawBody) -> Promise<WebhookVerification>
   * Recebe o CORPO CRU: qualquer reserialização quebra a assinatura.
   */
  verifyWebhook(
    headers: Record<string, string | undefined>,
    rawBody: string,
  ): Promise<WebhookVerification>
}

export class PaymentProviderError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly providerResponse?: unknown,
  ) {
    super(message)
    this.name = 'PaymentProviderError'
  }
}

/** Injetável para testar sem rede. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>
