import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { resolveProvider, type ProviderName } from './providers/index.js'
import { toCredentials } from './routes.js'

const PROVIDERS: ReadonlySet<string> = new Set(['mercadopago', 'stripe', 'asaas'])

const SETTINGS_COLUMNS =
  'tenant_id, default_provider, mercadopago_access_token, mercadopago_webhook_secret, stripe_secret_key, stripe_webhook_secret, asaas_api_key, asaas_webhook_token'

/**
 * Endpoints de notificação dos gateways.
 *
 * Registrado como plugin ENCAPSULADO (sem fastify-plugin) de propósito: o
 * parser abaixo entrega o corpo cru, necessário para conferir a assinatura —
 * qualquer reserialização do JSON invalidaria o HMAC. Fora deste escopo, o
 * parser padrão do Fastify continua valendo.
 *
 * A rota é pública por natureza (o gateway não tem sessão): a autenticidade
 * vem da assinatura, não de token de usuário.
 */
const webhookRoutes: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    done(null, body)
  })

  app.post<{ Params: { provider: string }; Body: string }>(
    '/:provider',
    {
      // Sem schema de corpo: a rota recebe texto cru para conferir a assinatura.
      config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const providerName = request.params.provider
      if (!PROVIDERS.has(providerName)) {
        return reply.status(404).send({ received: false, reason: 'provedor desconhecido' })
      }

      const rawBody = typeof request.body === 'string' ? request.body : ''

      // Caminho rápido: a notificação referencia uma cobrança nossa, e a
      // cobrança diz de qual estabelecimento é. Assim carregamos os segredos de
      // UM tenant em vez da tabela inteira — menos trabalho por notificação e,
      // sobretudo, menos superfície de exposição das chaves de gateway.
      //
      // O id extraído aqui vem de corpo NÃO verificado e serve apenas como
      // chave de busca parametrizada: a assinatura continua sendo conferida
      // antes de qualquer efeito.
      const settingsList = await loadCandidateSettings(app, providerName as ProviderName, rawBody)

      const headers = request.headers as Record<string, string | undefined>

      for (const settings of settingsList ?? []) {
        const credentials = toCredentials(settings as never)
        let provider
        try {
          provider = resolveProvider(providerName as ProviderName, credentials)
        } catch {
          continue // este estabelecimento não usa este gateway
        }

        const verification = await provider.verifyWebhook(headers, rawBody)
        if (!verification.valid) continue

        if (!verification.providerPaymentId || !verification.eventId) {
          // Assinatura válida mas sem referência utilizável: aceitar e ignorar
          // evita reentrega infinita pelo gateway.
          request.log.warn({ providerName }, 'Notificação sem identificador de cobrança')
          return reply.status(200).send({ received: true, applied: false })
        }

        const { data, error } = await app.supabaseAdmin.rpc('apply_payment_status', {
          p_provider: providerName,
          p_provider_payment_id: verification.providerPaymentId,
          p_status: verification.status ?? 'processing',
          p_event_id: verification.eventId,
          p_event_type: verification.eventType ?? 'payment.updated',
          p_payload: safeParse(rawBody),
        })

        if (error) {
          request.log.error({ err: error }, 'Falha ao aplicar notificação de pagamento')
          // 500 faz o gateway reenviar, que é o comportamento desejado.
          return reply.status(500).send({ received: false })
        }

        const result = data as { ok: boolean; duplicated: boolean; error: string | null }
        return reply.status(200).send({
          received: true,
          applied: result.ok && !result.duplicated,
          duplicated: result.duplicated,
        })
      }

      // Nenhuma configuração validou a assinatura.
      request.log.warn({ providerName }, 'Notificação com assinatura inválida')
      return reply.status(401).send({ received: false, reason: 'assinatura inválida' })
    },
  )
}

/** Coluna que prova que o estabelecimento usa aquele gateway. */
const WEBHOOK_SECRET_COLUMN: Record<ProviderName, string> = {
  mercadopago: 'mercadopago_webhook_secret',
  stripe: 'stripe_webhook_secret',
  asaas: 'asaas_webhook_token',
}

/**
 * Contrato: (provider, rawBody) -> string | null
 * Identificador da cobrança no provedor, lido do corpo SEM validar assinatura.
 * Serve só como pista de busca; nada é aplicado a partir dele.
 */
export function extractProviderPaymentId(provider: ProviderName, rawBody: string): string | null {
  try {
    const body = JSON.parse(rawBody) as Record<string, unknown>
    if (provider === 'mercadopago') {
      const data = body.data as { id?: unknown } | undefined
      return data?.id == null ? null : String(data.id)
    }
    if (provider === 'stripe') {
      const data = body.data as { object?: { id?: unknown } } | undefined
      return data?.object?.id == null ? null : String(data.object.id)
    }
    const payment = body.payment as { id?: unknown } | undefined
    return payment?.id == null ? null : String(payment.id)
  } catch {
    return null
  }
}

/**
 * Contrato: (app, provider, rawBody) -> Promise<unknown[]>
 * Configurações candidatas a validar esta notificação: a do estabelecimento
 * dono da cobrança quando ela é identificável, senão apenas as que têm o
 * gateway configurado — nunca a tabela inteira.
 */
async function loadCandidateSettings(
  app: FastifyInstance,
  provider: ProviderName,
  rawBody: string,
): Promise<Record<string, unknown>[]> {
  const providerPaymentId = extractProviderPaymentId(provider, rawBody)

  if (providerPaymentId) {
    const { data: payment } = await app.supabaseAdmin
      .from('payments')
      .select('tenant_id')
      .eq('provider', provider)
      .eq('provider_payment_id', providerPaymentId)
      .maybeSingle()

    if (payment?.tenant_id) {
      const { data } = await app.supabaseAdmin
        .from('payment_settings')
        .select(SETTINGS_COLUMNS)
        .eq('tenant_id', payment.tenant_id)
        .maybeSingle()
      if (data) return [data as Record<string, unknown>]
    }
  }

  // Cobrança ainda desconhecida (primeira notificação chegando antes do nosso
  // registro, ou evento sem referência): restringe ao gateway em questão.
  const { data } = await app.supabaseAdmin
    .from('payment_settings')
    .select(SETTINGS_COLUMNS)
    .not(WEBHOOK_SECRET_COLUMN[provider], 'is', null)

  return (data ?? []) as Record<string, unknown>[]
}

/** Contrato: (raw) -> unknown — nunca lança; corpo inválido vira objeto vazio. */
function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export default webhookRoutes
