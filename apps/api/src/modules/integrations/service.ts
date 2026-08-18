import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChannelCredentials, ChannelEvent, MarketplaceChannel } from './channels/types.js'
import { createIfoodChannel } from './channels/ifood.js'
import { createUberEatsChannel } from './channels/ubereats.js'

export interface IntegrationRecord {
  id: string
  tenant_id: string
  channel: 'ifood' | 'ubereats'
  external_store_id: string | null
  auto_accept: boolean
  is_receiving: boolean
}

export interface CredentialRecord {
  client_id: string | null
  client_secret: string | null
  access_token: string | null
  token_expires_at: string | null
  webhook_secret: string | null
}

/**
 * Códigos de evento que representam "pedido novo" em cada canal.
 * Só eles disparam a busca e a ingestão do pedido.
 */
export const NEW_ORDER_CODES: Record<'ifood' | 'ubereats', ReadonlySet<string>> = {
  ifood: new Set(['PLC', 'PLACED']),
  ubereats: new Set(['ORDERS.NOTIFICATION', 'ORDERS.SCHEDULED.NOTIFICATION']),
}

/** Contrato: (channel, code) -> boolean */
export function isNewOrderEvent(channel: 'ifood' | 'ubereats', code: string): boolean {
  return NEW_ORDER_CODES[channel].has(code.trim().toUpperCase())
}

/**
 * Códigos que indicam cancelamento pelo parceiro ou pelo cliente.
 * Contrato: (channel, code) -> boolean
 */
export function isCancellationEvent(channel: 'ifood' | 'ubereats', code: string): boolean {
  const normalized = code.trim().toUpperCase()
  return channel === 'ifood'
    ? normalized === 'CAN' || normalized === 'CANCELLED'
    : normalized.includes('CANCEL')
}

/**
 * Contrato: (integration, credentials, supabaseAdmin) -> MarketplaceChannel
 * Monta o cliente do canal, persistindo o token renovado para que a próxima
 * chamada não precise reautenticar.
 */
export function buildChannel(
  integration: IntegrationRecord,
  credentials: CredentialRecord,
  supabaseAdmin: SupabaseClient,
): MarketplaceChannel {
  const shared: ChannelCredentials = {
    clientId: credentials.client_id ?? '',
    clientSecret: credentials.client_secret ?? '',
    externalStoreId: integration.external_store_id ?? '',
    accessToken: credentials.access_token,
    tokenExpiresAt: credentials.token_expires_at,
    webhookSecret: credentials.webhook_secret,
  }

  const onTokenRefreshed = async (token: { accessToken: string; expiresAt: string }) => {
    await supabaseAdmin
      .from('integration_credentials')
      .update({ access_token: token.accessToken, token_expires_at: token.expiresAt })
      .eq('integration_id', integration.id)
  }

  return integration.channel === 'ifood'
    ? createIfoodChannel({ credentials: shared, onTokenRefreshed })
    : createUberEatsChannel({ credentials: shared, onTokenRefreshed })
}

export interface SyncSummary {
  polled: number
  ingested: number
  duplicated: number
  failed: number
  unmapped: string[]
}

/**
 * Contrato: (deps) -> Promise<SyncSummary>
 * Processa uma leva de eventos de um canal: registra cada um de forma
 * idempotente, ingere os pedidos novos e confirma o recebimento no parceiro.
 *
 * O acknowledgment só cobre os eventos que chegaram ao fim do processamento.
 * Um evento que falhou fica sem confirmação de propósito: o parceiro o
 * reentrega e a próxima rodada tenta de novo, em vez de perder o pedido.
 */
export async function processEvents(deps: {
  integration: IntegrationRecord
  channel: MarketplaceChannel
  events: readonly ChannelEvent[]
  supabaseAdmin: SupabaseClient
  logger?: { warn: (details: unknown, message: string) => void }
}): Promise<SyncSummary> {
  const { integration, channel, events, supabaseAdmin } = deps
  const summary: SyncSummary = {
    polled: events.length,
    ingested: 0,
    duplicated: 0,
    failed: 0,
    unmapped: [],
  }
  const processedEventIds: string[] = []

  for (const event of events) {
    const { data: recorded } = await supabaseAdmin.rpc('record_integration_event', {
      p_integration_id: integration.id,
      p_event_id: event.eventId,
      p_code: event.code,
      p_external_order_id: event.externalOrderId,
      p_payload: event.raw ?? {},
    })

    if ((recorded as { duplicated?: boolean } | null)?.duplicated) {
      summary.duplicated += 1
      processedEventIds.push(event.eventId)
      continue
    }

    if (!isNewOrderEvent(integration.channel, event.code) || !event.externalOrderId) {
      processedEventIds.push(event.eventId)
      continue
    }

    try {
      const order = await channel.fetchOrder(event.externalOrderId)
      const { data: ingested } = await supabaseAdmin.rpc('ingest_external_order', {
        p_integration_id: integration.id,
        p_payload: order,
      })

      const result = ingested as {
        ok?: boolean
        duplicated?: boolean
        unmappedItems?: string[]
      } | null

      if (result?.ok) {
        if (result.duplicated) summary.duplicated += 1
        else summary.ingested += 1
        summary.unmapped.push(...(result.unmappedItems ?? []))

        // Aceite automático só para pedido realmente novo: reconfirmar um
        // pedido já aceito seria ruído para o parceiro.
        if (integration.auto_accept && !result.duplicated) {
          await channel.applyAction(event.externalOrderId, 'confirm')
        }
      } else {
        summary.failed += 1
      }
      processedEventIds.push(event.eventId)
    } catch (error) {
      summary.failed += 1
      deps.logger?.warn({ err: error, eventId: event.eventId }, 'Falha ao ingerir pedido externo')
      await supabaseAdmin
        .from('integration_events')
        .update({ error: (error as Error).message })
        .eq('integration_id', integration.id)
        .eq('external_event_id', event.eventId)
    }
  }

  if (processedEventIds.length > 0) {
    await channel.acknowledgeEvents(processedEventIds)
    await supabaseAdmin
      .from('integration_events')
      .update({ processed_at: new Date().toISOString() })
      .eq('integration_id', integration.id)
      .in('external_event_id', processedEventIds)
  }

  return summary
}
