import { createHmac, timingSafeEqual } from 'node:crypto'
import type {
  AccessToken,
  ChannelCredentials,
  ChannelEvent,
  FetchLike,
  MarketplaceChannel,
  NormalizedItem,
  NormalizedOrder,
  OrderAction,
} from './types.js'
import { ChannelError, isTokenValid } from './types.js'

const AUTH_BASE = 'https://auth.uber.com'
const API_BASE = 'https://api.uber.com'

/** Escopos exigidos para operar pedidos da loja. */
const SCOPES = 'eats.store eats.order eats.pos_provisioning'

/**
 * Cliente do Uber Eats (Marketplace / POS API).
 *
 * Ao contrário do iFood, o Uber Eats entrega por WEBHOOK: envia
 * `orders.notification` para a URL cadastrada, assinada em `X-Uber-Signature`
 * (HMAC-SHA256 do corpo cru com o client secret). O corpo traz apenas o
 * identificador; os detalhes vêm de uma segunda chamada.
 *
 * NÃO HOMOLOGADO: escrito a partir da documentação pública, sem credenciais
 * nem acesso ao ambiente do parceiro.
 */

/**
 * Contrato: (amount) -> number
 * O Uber Eats trabalha em unidades menores da moeda: 2590 significa R$ 25,90.
 */
export function fromMinorUnits(amount: unknown): number {
  const value = Number(amount ?? 0)
  if (!Number.isFinite(value)) return 0
  return Math.round(value) / 100
}

/** Contrato: (type) -> 'delivery' | 'takeaway' */
export function mapUberOrderType(type: string): 'delivery' | 'takeaway' {
  return type?.toUpperCase() === 'PICK_UP' ? 'takeaway' : 'delivery'
}

/**
 * Contrato: (order) -> NormalizedOrder
 * Traduz o pedido do Uber Eats para o formato da ingestão.
 */
export function normalizeUberOrder(order: Record<string, unknown>): NormalizedOrder {
  const cart = (order.cart ?? {}) as Record<string, unknown>
  const payment = (order.payment ?? {}) as Record<string, unknown>
  const charges = (payment.charges ?? {}) as Record<string, unknown>
  const eater = (order.eater ?? {}) as Record<string, unknown>
  const deliveries = (order.deliveries ?? []) as Array<Record<string, unknown>>
  const location = (deliveries[0]?.location ?? null) as Record<string, unknown> | null

  const items: NormalizedItem[] = ((cart.items ?? []) as Array<Record<string, unknown>>).map(
    (item) => {
      const price = (item.price ?? {}) as Record<string, unknown>
      const unitPrice = (price.unit_price ?? {}) as Record<string, unknown>

      const options = ((item.selected_modifier_groups ?? []) as Array<Record<string, unknown>>)
        .flatMap((group) =>
          ((group.selected_items ?? []) as Array<Record<string, unknown>>).map((selected) => {
            const selectedPrice = (selected.price ?? {}) as Record<string, unknown>
            const selectedUnit = (selectedPrice.unit_price ?? {}) as Record<string, unknown>
            return {
              name: String(selected.title ?? ''),
              priceDelta: fromMinorUnits(selectedUnit.amount),
              groupName: (group.title as string | undefined) ?? null,
            }
          }),
        )

      return {
        // external_data é o campo em que a loja guarda o próprio código; é ele
        // que casa com o nosso catálogo. O id do Uber muda entre pedidos.
        externalItemId: String(item.external_data ?? item.id ?? ''),
        name: String(item.title ?? 'Item'),
        quantity: Number(item.quantity ?? 1),
        unitPrice: fromMinorUnits(unitPrice.amount),
        notes: (item.special_instructions as string | undefined) ?? null,
        options,
      }
    },
  )

  const subtotal = fromMinorUnits((charges.sub_total as Record<string, unknown> | undefined)?.amount)
  const total = fromMinorUnits((charges.total as Record<string, unknown> | undefined)?.amount)
  const deliveryFee = fromMinorUnits(
    (charges.delivery_fee as Record<string, unknown> | undefined)?.amount,
  )
  // Promoções vêm com sinal positivo e representam abatimento.
  const discount = Math.abs(
    fromMinorUnits((charges.promotion_applied as Record<string, unknown> | undefined)?.amount),
  )

  const eaterName = [eater.first_name, eater.last_name].filter(Boolean).join(' ').trim()

  return {
    externalOrderId: String(order.id ?? ''),
    displayId: (order.display_id as string | undefined) ?? null,
    channel: mapUberOrderType(String(order.type ?? '')),
    items,
    subtotal,
    discount,
    deliveryFee,
    total,
    // Pedidos do Uber Eats são pagos no app antes de chegarem à loja.
    paymentStatus: 'paid',
    customer: {
      name: eaterName || null,
      phone: (eater.phone as string | undefined) ?? null,
    },
    deliveryAddress: location
      ? {
          street: location.street_address ?? null,
          complement: location.unit_number ?? null,
          neighborhood: location.neighborhood ?? null,
          city: location.city ?? null,
          state: location.state ?? null,
          zipCode: location.postal_code ?? null,
          reference: location.business_name ?? null,
        }
      : null,
    notes: (order.special_instructions as string | undefined) ?? null,
    placedAt: (order.placed_at as string | undefined) ?? null,
  }
}

/** Contrato: (secret, rawBody) -> string — assinatura esperada do webhook. */
export function uberSignature(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex')
}

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8')
  const bufferB = Buffer.from(b, 'utf8')
  if (bufferA.length !== bufferB.length) return false
  return timingSafeEqual(bufferA, bufferB)
}

export interface UberEatsChannelOptions {
  readonly credentials: ChannelCredentials
  readonly fetchImpl?: FetchLike
  readonly authBaseUrl?: string
  readonly apiBaseUrl?: string
  readonly onTokenRefreshed?: (token: AccessToken) => Promise<void>
}

export function createUberEatsChannel(options: UberEatsChannelOptions): MarketplaceChannel {
  const fetchImpl = options.fetchImpl ?? fetch
  const authBase = options.authBaseUrl ?? AUTH_BASE
  const apiBase = options.apiBaseUrl ?? API_BASE
  let token = options.credentials.accessToken ?? null
  let tokenExpiresAt = options.credentials.tokenExpiresAt ?? null

  async function authenticate(): Promise<AccessToken> {
    const form = new URLSearchParams()
    form.set('client_id', options.credentials.clientId)
    form.set('client_secret', options.credentials.clientSecret)
    form.set('grant_type', 'client_credentials')
    form.set('scope', SCOPES)

    const response = await fetchImpl(`${authBase}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })

    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (!response.ok || !payload?.access_token) {
      throw new ChannelError(
        `Uber Eats recusou a autenticação (HTTP ${response.status})`,
        response.status,
        payload,
      )
    }

    const expiresAt = new Date(Date.now() + Number(payload.expires_in ?? 3600) * 1000).toISOString()
    token = String(payload.access_token)
    tokenExpiresAt = expiresAt

    await options.onTokenRefreshed?.({ accessToken: token, expiresAt })
    return { accessToken: token, expiresAt }
  }

  async function ensureToken(): Promise<string> {
    if (token && isTokenValid(tokenExpiresAt)) return token
    const refreshed = await authenticate()
    return refreshed.accessToken
  }

  async function authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const accessToken = await ensureToken()
    return fetchImpl(`${apiBase}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        ...init.headers,
      },
    })
  }

  return {
    name: 'ubereats',
    authenticate,

    async pollEvents(): Promise<ChannelEvent[]> {
      // O Uber Eats notifica por webhook; não há fila a consultar.
      return []
    },

    async acknowledgeEvents(): Promise<void> {
      // Sem acknowledgment: a confirmação é o HTTP 200 do webhook.
    },

    async fetchOrder(externalOrderId: string): Promise<NormalizedOrder> {
      const response = await authorizedFetch(`/v2/eats/order/${externalOrderId}`, { method: 'GET' })

      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
      if (!response.ok || !payload) {
        throw new ChannelError(
          `Uber Eats não devolveu o pedido ${externalOrderId} (HTTP ${response.status})`,
          response.status,
          payload,
        )
      }

      return normalizeUberOrder(payload)
    },

    async applyAction(externalOrderId: string, action: OrderAction, reason?: string): Promise<void> {
      // O Uber Eats só expõe aceitar, recusar e cancelar: preparo e despacho
      // são acompanhados pela própria plataforma, então viram no-op aqui.
      if (action === 'start_preparation' || action === 'ready' || action === 'dispatch') return

      const path =
        action === 'confirm'
          ? `/v1/eats/orders/${externalOrderId}/accept_pos_order`
          : `/v1/eats/orders/${externalOrderId}/cancel`

      const response = await authorizedFetch(path, {
        method: 'POST',
        ...(action === 'cancel'
          ? {
              body: JSON.stringify({
                reason: reason ?? 'STORE_CLOSED',
                cancelling_party: 'RESTAURANT',
              }),
            }
          : { body: JSON.stringify({}) }),
      })

      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        throw new ChannelError(
          `Uber Eats recusou a ação ${action} (HTTP ${response.status})`,
          response.status,
          payload,
        )
      }
    },

    async setStoreAvailability(available: boolean, reason?: string): Promise<void> {
      const response = await authorizedFetch(
        `/v1/eats/stores/${options.credentials.externalStoreId}/status`,
        {
          method: 'POST',
          body: JSON.stringify({
            status: available ? 'ONLINE' : 'PAUSED',
            ...(available
              ? {}
              : {
                  reason: {
                    pause_duration_in_minutes: 60,
                    pause_reason: reason ?? 'Loja pausada pelo estabelecimento',
                  },
                }),
          }),
        },
      )

      if (!response.ok) {
        throw new ChannelError(
          `Uber Eats recusou mudar o status da loja (HTTP ${response.status})`,
          response.status,
        )
      }
    },

    async verifyWebhook(headers, rawBody) {
      const secret = options.credentials.webhookSecret ?? options.credentials.clientSecret
      const received = headers['x-uber-signature']
      if (!received) return { valid: false, reason: 'assinatura ausente' }

      if (!safeEqual(uberSignature(secret, rawBody), received)) {
        return { valid: false, reason: 'assinatura inválida' }
      }

      let body: Record<string, unknown>
      try {
        body = JSON.parse(rawBody) as Record<string, unknown>
      } catch {
        return { valid: false, reason: 'corpo inválido' }
      }

      const meta = (body.meta ?? {}) as Record<string, unknown>

      return {
        valid: true,
        event: {
          eventId: String(body.event_id ?? ''),
          code: String(body.event_type ?? 'orders.notification'),
          externalOrderId: (meta.resource_id as string | undefined) ?? null,
          raw: body,
        },
      }
    },
  }
}
