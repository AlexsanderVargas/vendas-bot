/**
 * Porta comum dos marketplaces (iFood, Uber Eats).
 *
 * IMPORTANTE: os clientes concretos seguem a documentação pública de cada
 * parceiro, mas NÃO foram exercitados contra os ambientes reais — não há
 * credenciais nesta base, e ambos exigem homologação e aprovação comercial
 * antes de operar. Os testes cobrem formato de requisição, mapeamento de
 * status, normalização de pedido e verificação de assinatura, com transporte
 * HTTP mockado.
 */

export type ChannelName = 'ifood' | 'ubereats'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface ChannelCredentials {
  readonly clientId: string
  readonly clientSecret: string
  readonly externalStoreId: string
  /** Token em cache; quando ausente ou vencido, o cliente reautentica. */
  readonly accessToken?: string | null
  readonly tokenExpiresAt?: string | null
  readonly webhookSecret?: string | null
}

export interface AccessToken {
  readonly accessToken: string
  readonly expiresAt: string
}

/** Evento normalizado, independente do parceiro. */
export interface ChannelEvent {
  readonly eventId: string
  readonly code: string
  readonly externalOrderId: string | null
  readonly raw: unknown
}

/** Item do pedido, já com o preço praticado pelo marketplace. */
export interface NormalizedItem {
  readonly externalItemId: string
  readonly name: string
  readonly quantity: number
  readonly unitPrice: number
  readonly notes?: string | null
  readonly options?: ReadonlyArray<{
    readonly name: string
    readonly priceDelta: number
    readonly groupName?: string | null
  }>
}

/**
 * Pedido normalizado consumido por public.ingest_external_order.
 * Os valores monetários são os do parceiro — quem definiu o que o cliente
 * pagou foi ele, não o nosso catálogo.
 */
export interface NormalizedOrder {
  readonly externalOrderId: string
  readonly displayId: string | null
  readonly channel: 'delivery' | 'takeaway'
  readonly items: readonly NormalizedItem[]
  readonly subtotal: number
  readonly discount: number
  readonly deliveryFee: number
  readonly total: number
  readonly paymentStatus: 'paid' | 'pending'
  readonly customer: { readonly name: string | null; readonly phone: string | null }
  readonly deliveryAddress: Record<string, unknown> | null
  readonly notes: string | null
  readonly placedAt: string | null
}

export type OrderAction = 'confirm' | 'start_preparation' | 'ready' | 'dispatch' | 'cancel'

export interface MarketplaceChannel {
  readonly name: ChannelName
  authenticate(): Promise<AccessToken>
  /** Busca eventos pendentes. Canais por webhook devolvem lista vazia. */
  pollEvents(): Promise<ChannelEvent[]>
  /** Confirma o recebimento dos eventos, para o parceiro não reentregar. */
  acknowledgeEvents(eventIds: readonly string[]): Promise<void>
  fetchOrder(externalOrderId: string): Promise<NormalizedOrder>
  applyAction(externalOrderId: string, action: OrderAction, reason?: string): Promise<void>
  /** Abre ou pausa a loja no marketplace. */
  setStoreAvailability(available: boolean, reason?: string): Promise<void>
  /** Verifica a assinatura de um webhook. Canais por polling devolvem inválido. */
  verifyWebhook(
    headers: Record<string, string | undefined>,
    rawBody: string,
  ): Promise<{ valid: boolean; reason?: string; event?: ChannelEvent }>
}

export class ChannelError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly providerResponse?: unknown,
  ) {
    super(message)
    this.name = 'ChannelError'
  }
}

/** Contrato: (expiresAt, skewSeconds?) -> boolean — token ainda utilizável. */
export function isTokenValid(expiresAt: string | null | undefined, skewSeconds = 60): boolean {
  if (!expiresAt) return false
  const expiry = Date.parse(expiresAt)
  if (Number.isNaN(expiry)) return false
  // Margem de segurança: um token que expira em 5s não sobrevive à chamada.
  return expiry - skewSeconds * 1000 > Date.now()
}
