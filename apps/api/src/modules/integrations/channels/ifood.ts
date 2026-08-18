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

const API_BASE = 'https://merchant-api.ifood.com.br'

/**
 * Cliente do iFood (Merchant API).
 *
 * O iFood entrega pedidos por POLLING, não por webhook: a aplicação consulta
 * `events:polling` periodicamente e precisa confirmar o recebimento em
 * `events/acknowledgment` — sem o acknowledgment, o mesmo evento volta na
 * próxima chamada.
 *
 * NÃO HOMOLOGADO: escrito a partir da documentação pública, sem credenciais
 * nem acesso ao ambiente do parceiro.
 */

/** Ações do pedido no vocabulário do iFood. */
const ACTION_PATH: Record<OrderAction, string> = {
  confirm: 'confirm',
  start_preparation: 'startPreparation',
  ready: 'readyToPickup',
  dispatch: 'dispatch',
  cancel: 'requestCancellation',
}

/**
 * Contrato: (code) -> string — normaliza o código do evento do iFood.
 * PLC = colocado, CFM = confirmado, CAN = cancelado, CON = concluído.
 */
export function normalizeIfoodEventCode(code: string): string {
  return code.trim().toUpperCase()
}

/** Contrato: (orderType) -> 'delivery' | 'takeaway' */
export function mapIfoodOrderType(orderType: string): 'delivery' | 'takeaway' {
  return orderType?.toUpperCase() === 'TAKEOUT' ? 'takeaway' : 'delivery'
}

/**
 * Contrato: (order) -> NormalizedOrder
 * Traduz o pedido do iFood para o formato consumido por
 * public.ingest_external_order. Exportada para ser testável sem rede.
 */
export function normalizeIfoodOrder(order: Record<string, unknown>): NormalizedOrder {
  const total = (order.total ?? {}) as Record<string, unknown>
  const customer = (order.customer ?? {}) as Record<string, unknown>
  const phone = (customer.phone ?? {}) as Record<string, unknown>
  const delivery = (order.delivery ?? {}) as Record<string, unknown>
  const address = (delivery.deliveryAddress ?? null) as Record<string, unknown> | null
  const payments = (order.payments ?? {}) as Record<string, unknown>

  const items: NormalizedItem[] = ((order.items ?? []) as Array<Record<string, unknown>>).map(
    (item) => ({
      // externalCode é o código que o restaurante cadastrou no iFood; é ele
      // que casa com o nosso catálogo. O id do iFood muda entre pedidos.
      externalItemId: String(item.externalCode ?? item.id ?? ''),
      name: String(item.name ?? 'Item'),
      quantity: Number(item.quantity ?? 1),
      unitPrice: Number(item.unitPrice ?? 0),
      notes: (item.observations as string | undefined) ?? null,
      options: ((item.options ?? []) as Array<Record<string, unknown>>).map((option) => ({
        name: String(option.name ?? ''),
        priceDelta: Number(option.unitPrice ?? option.price ?? 0),
        groupName: (option.groupName as string | undefined) ?? null,
      })),
    }),
  )

  // 'benefits' são descontos bancados por iFood/loja; entram como desconto.
  const discount = Number(total.benefits ?? 0)
  const deliveryFee = Number(total.deliveryFee ?? 0)
  const subtotal = Number(total.subTotal ?? 0)
  const orderAmount = Number(total.orderAmount ?? subtotal - discount + deliveryFee)

  const prepaid = Number(payments.prepaid ?? 0)

  return {
    externalOrderId: String(order.id ?? ''),
    displayId: (order.displayId as string | undefined) ?? null,
    channel: mapIfoodOrderType(String(order.orderType ?? 'DELIVERY')),
    items,
    subtotal,
    discount,
    deliveryFee,
    total: orderAmount,
    // Pedido pré-pago no app já entra quitado; pagamento na entrega fica pendente.
    paymentStatus: prepaid > 0 ? 'paid' : 'pending',
    customer: {
      name: (customer.name as string | undefined) ?? null,
      phone: (phone.number as string | undefined) ?? null,
    },
    deliveryAddress: address
      ? {
          street: address.streetName ?? null,
          number: address.streetNumber ?? null,
          complement: address.complement ?? null,
          neighborhood: address.neighborhood ?? null,
          city: address.city ?? null,
          state: address.state ?? null,
          zipCode: address.postalCode ?? null,
          reference: address.reference ?? null,
        }
      : null,
    notes: (order.observations as string | undefined) ?? null,
    placedAt: (order.createdAt as string | undefined) ?? null,
  }
}

export interface IfoodChannelOptions {
  readonly credentials: ChannelCredentials
  readonly fetchImpl?: FetchLike
  readonly baseUrl?: string
  /** Persiste o token renovado, para não reautenticar a cada chamada. */
  readonly onTokenRefreshed?: (token: AccessToken) => Promise<void>
}

export function createIfoodChannel(options: IfoodChannelOptions): MarketplaceChannel {
  const fetchImpl = options.fetchImpl ?? fetch
  const baseUrl = options.baseUrl ?? API_BASE
  let token = options.credentials.accessToken ?? null
  let tokenExpiresAt = options.credentials.tokenExpiresAt ?? null

  async function authenticate(): Promise<AccessToken> {
    const form = new URLSearchParams()
    form.set('grantType', 'client_credentials')
    form.set('clientId', options.credentials.clientId)
    form.set('clientSecret', options.credentials.clientSecret)

    const response = await fetchImpl(`${baseUrl}/authentication/v1.0/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })

    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (!response.ok || !payload?.accessToken) {
      throw new ChannelError(
        `iFood recusou a autenticação (HTTP ${response.status})`,
        response.status,
        payload,
      )
    }

    const expiresAt = new Date(Date.now() + Number(payload.expiresIn ?? 3600) * 1000).toISOString()
    token = String(payload.accessToken)
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
    return fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        ...init.headers,
      },
    })
  }

  return {
    name: 'ifood',
    authenticate,

    async pollEvents(): Promise<ChannelEvent[]> {
      const response = await authorizedFetch('/events/v1.0/events:polling', {
        method: 'GET',
        headers: { 'x-polling-merchants': options.credentials.externalStoreId },
      })

      // 204 significa "nada novo" e é resposta normal, não erro.
      if (response.status === 204) return []

      if (!response.ok) {
        throw new ChannelError(
          `iFood recusou o polling (HTTP ${response.status})`,
          response.status,
        )
      }

      const events = (await response.json().catch(() => [])) as Array<Record<string, unknown>>

      return events.map((event) => ({
        eventId: String(event.id ?? ''),
        code: normalizeIfoodEventCode(String(event.code ?? event.fullCode ?? '')),
        externalOrderId: (event.orderId as string | undefined) ?? null,
        raw: event,
      }))
    },

    async acknowledgeEvents(eventIds: readonly string[]): Promise<void> {
      if (eventIds.length === 0) return

      const response = await authorizedFetch('/events/v1.0/events/acknowledgment', {
        method: 'POST',
        body: JSON.stringify(eventIds.map((id) => ({ id }))),
      })

      if (!response.ok) {
        throw new ChannelError(
          `iFood recusou o acknowledgment (HTTP ${response.status})`,
          response.status,
        )
      }
    },

    async fetchOrder(externalOrderId: string): Promise<NormalizedOrder> {
      const response = await authorizedFetch(`/order/v1.0/orders/${externalOrderId}`, {
        method: 'GET',
      })

      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
      if (!response.ok || !payload) {
        throw new ChannelError(
          `iFood não devolveu o pedido ${externalOrderId} (HTTP ${response.status})`,
          response.status,
          payload,
        )
      }

      return normalizeIfoodOrder(payload)
    },

    async applyAction(externalOrderId: string, action: OrderAction, reason?: string): Promise<void> {
      const path = `/order/v1.0/orders/${externalOrderId}/${ACTION_PATH[action]}`
      const response = await authorizedFetch(path, {
        method: 'POST',
        ...(action === 'cancel'
          ? {
              body: JSON.stringify({
                reason: reason ?? 'Cancelamento solicitado pelo estabelecimento',
                cancellationCode: '501',
              }),
            }
          : {}),
      })

      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        throw new ChannelError(
          `iFood recusou a ação ${action} (HTTP ${response.status})`,
          response.status,
          payload,
        )
      }
    },

    async setStoreAvailability(available: boolean, reason?: string): Promise<void> {
      const merchantId = options.credentials.externalStoreId

      if (available) {
        // Reabrir = remover as interrupções ativas.
        const listing = await authorizedFetch(
          `/merchant/v1.0/merchants/${merchantId}/interruptions`,
          { method: 'GET' },
        )
        const interruptions = (await listing.json().catch(() => [])) as Array<{ id?: string }>

        for (const interruption of interruptions) {
          if (!interruption.id) continue
          await authorizedFetch(
            `/merchant/v1.0/merchants/${merchantId}/interruptions/${interruption.id}`,
            { method: 'DELETE' },
          )
        }
        return
      }

      const start = new Date()
      const end = new Date(start.getTime() + 3_600_000)

      const response = await authorizedFetch(
        `/merchant/v1.0/merchants/${merchantId}/interruptions`,
        {
          method: 'POST',
          body: JSON.stringify({
            description: reason ?? 'Loja pausada pelo estabelecimento',
            start: start.toISOString(),
            end: end.toISOString(),
          }),
        },
      )

      if (!response.ok) {
        throw new ChannelError(
          `iFood recusou pausar a loja (HTTP ${response.status})`,
          response.status,
        )
      }
    },

    async verifyWebhook() {
      // O iFood opera por polling; não há webhook a verificar.
      return { valid: false, reason: 'iFood entrega eventos por polling, não por webhook' }
    },
  }
}
