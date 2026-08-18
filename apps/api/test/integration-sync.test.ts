import { describe, expect, it, vi } from 'vitest'
import {
  isCancellationEvent,
  isNewOrderEvent,
  processEvents,
  type IntegrationRecord,
} from '../src/modules/integrations/service.js'
import type { ChannelEvent, MarketplaceChannel } from '../src/modules/integrations/channels/types.js'

const INTEGRATION: IntegrationRecord = {
  id: 'int-1',
  tenant_id: 'tenant-1',
  channel: 'ifood',
  external_store_id: 'merchant-abc',
  auto_accept: false,
  is_receiving: true,
}

/** Supabase falso que registra as chamadas de RPC e devolve respostas roteirizadas. */
function fakeAdmin(responses: Record<string, (params: Record<string, unknown>) => unknown>) {
  const calls: Array<{ name: string; params: Record<string, unknown> }> = []
  const updates: unknown[] = []

  const client = {
    async rpc(name: string, params: Record<string, unknown>) {
      calls.push({ name, params })
      return { data: responses[name]?.(params) ?? null, error: null }
    },
    from() {
      const builder = {
        update(values: unknown) {
          updates.push(values)
          return builder
        },
        eq: () => builder,
        in: () => builder,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
      }
      return builder
    },
  }

  return { client: client as never, calls, updates }
}

function fakeChannel(overrides: Partial<MarketplaceChannel> = {}): MarketplaceChannel {
  return {
    name: 'ifood',
    authenticate: vi.fn(),
    pollEvents: vi.fn(async () => []),
    acknowledgeEvents: vi.fn(async () => undefined),
    fetchOrder: vi.fn(async () => ({
      externalOrderId: 'IFOOD-1',
      displayId: '4821',
      channel: 'delivery' as const,
      items: [],
      subtotal: 10,
      discount: 0,
      deliveryFee: 0,
      total: 10,
      paymentStatus: 'paid' as const,
      customer: { name: null, phone: null },
      deliveryAddress: null,
      notes: null,
      placedAt: null,
    })),
    applyAction: vi.fn(async () => undefined),
    setStoreAvailability: vi.fn(async () => undefined),
    verifyWebhook: vi.fn(async () => ({ valid: false })),
    ...overrides,
  } as MarketplaceChannel
}

const EVENTO_NOVO: ChannelEvent = {
  eventId: 'evt-1',
  code: 'PLC',
  externalOrderId: 'IFOOD-1',
  raw: {},
}

describe('isNewOrderEvent', () => {
  it('reconhece PLC do iFood', () => {
    expect(isNewOrderEvent('ifood', 'PLC')).toBe(true)
    expect(isNewOrderEvent('ifood', ' plc ')).toBe(true)
  })
  it('não confunde confirmação com pedido novo', () => {
    expect(isNewOrderEvent('ifood', 'CFM')).toBe(false)
  })
  it('reconhece a notificação do Uber Eats', () => {
    expect(isNewOrderEvent('ubereats', 'orders.notification')).toBe(true)
  })
})

describe('isCancellationEvent', () => {
  it('reconhece cancelamento do iFood', () => {
    expect(isCancellationEvent('ifood', 'CAN')).toBe(true)
  })
  it('reconhece cancelamento do Uber Eats por substring', () => {
    expect(isCancellationEvent('ubereats', 'orders.cancel')).toBe(true)
  })
  it('não marca evento comum como cancelamento', () => {
    expect(isCancellationEvent('ifood', 'PLC')).toBe(false)
  })
})

describe('processEvents', () => {
  it('ingere pedido novo e confirma o evento no parceiro', async () => {
    const admin = fakeAdmin({
      record_integration_event: () => ({ ok: true, duplicated: false, eventId: 'x' }),
      ingest_external_order: () => ({ ok: true, duplicated: false, unmappedItems: [] }),
    })
    const channel = fakeChannel()

    const summary = await processEvents({
      integration: INTEGRATION,
      channel,
      events: [EVENTO_NOVO],
      supabaseAdmin: admin.client,
    })

    expect(summary).toMatchObject({ polled: 1, ingested: 1, duplicated: 0, failed: 0 })
    expect(channel.acknowledgeEvents).toHaveBeenCalledWith(['evt-1'])
  })

  it('evento reentregue é contado como duplicado sem buscar o pedido', async () => {
    const admin = fakeAdmin({
      record_integration_event: () => ({ ok: true, duplicated: true }),
    })
    const channel = fakeChannel()

    const summary = await processEvents({
      integration: INTEGRATION,
      channel,
      events: [EVENTO_NOVO],
      supabaseAdmin: admin.client,
    })

    expect(summary.duplicated).toBe(1)
    expect(channel.fetchOrder).not.toHaveBeenCalled()
    expect(channel.acknowledgeEvents).toHaveBeenCalledWith(['evt-1'])
  })

  it('evento que não é pedido novo é confirmado sem ingestão', async () => {
    const admin = fakeAdmin({
      record_integration_event: () => ({ ok: true, duplicated: false }),
    })
    const channel = fakeChannel()

    const summary = await processEvents({
      integration: INTEGRATION,
      channel,
      events: [{ ...EVENTO_NOVO, code: 'CFM' }],
      supabaseAdmin: admin.client,
    })

    expect(summary.ingested).toBe(0)
    expect(channel.fetchOrder).not.toHaveBeenCalled()
    expect(channel.acknowledgeEvents).toHaveBeenCalledWith(['evt-1'])
  })

  it('falha na ingestão NÃO confirma o evento, para o parceiro reentregar', async () => {
    const admin = fakeAdmin({
      record_integration_event: () => ({ ok: true, duplicated: false }),
    })
    const channel = fakeChannel({
      fetchOrder: vi.fn(async () => {
        throw new Error('parceiro indisponível')
      }),
    })

    const summary = await processEvents({
      integration: INTEGRATION,
      channel,
      events: [EVENTO_NOVO],
      supabaseAdmin: admin.client,
    })

    expect(summary.failed).toBe(1)
    expect(channel.acknowledgeEvents).not.toHaveBeenCalled()
  })

  it('reporta itens sem mapeamento para o operador', async () => {
    const admin = fakeAdmin({
      record_integration_event: () => ({ ok: true, duplicated: false }),
      ingest_external_order: () => ({
        ok: true,
        duplicated: false,
        unmappedItems: ['Combo promocional'],
      }),
    })

    const summary = await processEvents({
      integration: INTEGRATION,
      channel: fakeChannel(),
      events: [EVENTO_NOVO],
      supabaseAdmin: admin.client,
    })

    expect(summary.unmapped).toEqual(['Combo promocional'])
  })

  it('aceite automático confirma o pedido no parceiro', async () => {
    const admin = fakeAdmin({
      record_integration_event: () => ({ ok: true, duplicated: false }),
      ingest_external_order: () => ({ ok: true, duplicated: false, unmappedItems: [] }),
    })
    const channel = fakeChannel()

    await processEvents({
      integration: { ...INTEGRATION, auto_accept: true },
      channel,
      events: [EVENTO_NOVO],
      supabaseAdmin: admin.client,
    })

    expect(channel.applyAction).toHaveBeenCalledWith('IFOOD-1', 'confirm')
  })

  it('aceite automático não reconfirma pedido já conhecido', async () => {
    const admin = fakeAdmin({
      record_integration_event: () => ({ ok: true, duplicated: false }),
      ingest_external_order: () => ({ ok: true, duplicated: true, unmappedItems: [] }),
    })
    const channel = fakeChannel()

    await processEvents({
      integration: { ...INTEGRATION, auto_accept: true },
      channel,
      events: [EVENTO_NOVO],
      supabaseAdmin: admin.client,
    })

    expect(channel.applyAction).not.toHaveBeenCalled()
  })

  it('não chama acknowledgment quando não há evento algum', async () => {
    const channel = fakeChannel()
    const summary = await processEvents({
      integration: INTEGRATION,
      channel,
      events: [],
      supabaseAdmin: fakeAdmin({}).client,
    })

    expect(summary.polled).toBe(0)
    expect(channel.acknowledgeEvents).not.toHaveBeenCalled()
  })

  it('processa uma leva mista contando cada resultado', async () => {
    let call = 0
    const admin = fakeAdmin({
      record_integration_event: () => {
        call += 1
        return { ok: true, duplicated: call === 2 }
      },
      ingest_external_order: () => ({ ok: true, duplicated: false, unmappedItems: [] }),
    })

    const summary = await processEvents({
      integration: INTEGRATION,
      channel: fakeChannel(),
      events: [
        { ...EVENTO_NOVO, eventId: 'e1' },                 // novo -> ingerido
        { ...EVENTO_NOVO, eventId: 'e2' },                 // reentregue -> duplicado
        { ...EVENTO_NOVO, eventId: 'e3', code: 'CFM' },    // confirmação -> só registrado
      ],
      supabaseAdmin: admin.client,
    })

    expect(summary).toMatchObject({ polled: 3, ingested: 1, duplicated: 1, failed: 0 })
  })
})
