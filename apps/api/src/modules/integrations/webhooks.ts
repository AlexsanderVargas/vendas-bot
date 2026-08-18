import type { FastifyPluginAsync } from 'fastify'
import { buildChannel, isNewOrderEvent, processEvents } from './service.js'
import type { CredentialRecord, IntegrationRecord } from './service.js'

const WEBHOOK_CHANNELS: ReadonlySet<string> = new Set(['ubereats'])

const INTEGRATION_COLUMNS = 'id, tenant_id, channel, external_store_id, auto_accept, is_receiving'
const CREDENTIAL_COLUMNS =
  'integration_id, client_id, client_secret, access_token, token_expires_at, webhook_secret'

/**
 * Notificações dos marketplaces que operam por webhook (hoje, Uber Eats).
 *
 * Plugin ENCAPSULADO pelo mesmo motivo do webhook de pagamento: a assinatura
 * é calculada sobre o corpo cru, e reserializar o JSON a invalidaria. O
 * parser abaixo não vaza para as demais rotas.
 *
 * A rota é pública por natureza — o parceiro não tem sessão. A autenticidade
 * vem da assinatura.
 */
const marketplaceWebhooks: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    done(null, body)
  })

  app.post<{ Params: { channel: string }; Body: string }>(
    '/:channel',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const channelName = request.params.channel
      if (!WEBHOOK_CHANNELS.has(channelName)) {
        return reply.status(404).send({ received: false, reason: 'canal sem webhook' })
      }

      const rawBody = typeof request.body === 'string' ? request.body : ''
      const headers = request.headers as Record<string, string | undefined>

      const { data: integrations } = await app.supabaseAdmin
        .from('integrations')
        .select(INTEGRATION_COLUMNS)
        .eq('channel', channelName)
        .eq('status', 'connected')

      for (const row of (integrations ?? []) as IntegrationRecord[]) {
        const { data: credentials } = await app.supabaseAdmin
          .from('integration_credentials')
          .select(CREDENTIAL_COLUMNS)
          .eq('integration_id', row.id)
          .maybeSingle()

        if (!credentials) continue

        const channel = buildChannel(row, credentials as CredentialRecord, app.supabaseAdmin)
        const verification = await channel.verifyWebhook(headers, rawBody)
        if (!verification.valid || !verification.event) continue

        // Loja pausada: aceita a notificação para o parceiro não reentregar,
        // mas não ingere o pedido.
        if (!row.is_receiving) {
          return reply.status(200).send({ received: true, applied: false, reason: 'canal pausado' })
        }

        const summary = await processEvents({
          integration: row,
          channel,
          events: [verification.event],
          supabaseAdmin: app.supabaseAdmin,
          logger: request.log,
        })

        // Falha na ingestão devolve 500 de propósito: o Uber Eats reentrega, e
        // reentrega é melhor do que pedido perdido.
        if (summary.failed > 0) {
          return reply.status(500).send({ received: false })
        }

        return reply.status(200).send({
          received: true,
          applied: summary.ingested > 0,
          duplicated: summary.duplicated > 0,
          unmapped: summary.unmapped,
          isOrderEvent: isNewOrderEvent(row.channel, verification.event.code),
        })
      }

      request.log.warn({ channelName }, 'Notificação de marketplace com assinatura inválida')
      return reply.status(401).send({ received: false, reason: 'assinatura inválida' })
    },
  )
}

export default marketplaceWebhooks
