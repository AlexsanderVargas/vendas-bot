import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import { ErrorResponse, Money, Slug, StandardErrors, Uuid } from '@vendas-bot/shared'
import {
  PaymentProviderError,
  resolveProvider,
  type ProviderCredentials,
  type ProviderName,
} from './providers/index.js'

const PROVIDERS = ['mercadopago', 'stripe', 'asaas'] as const
const ProviderSchema = Type.Union(PROVIDERS.map((provider) => Type.Literal(provider)))

const MethodSchema = Type.Union([
  Type.Literal('pix'),
  Type.Literal('credit_card'),
  Type.Literal('debit_card'),
  Type.Literal('boleto'),
])

/** Contrato de saída da cobrança criada. */
const PaymentResult = Type.Object({
  id: Uuid,
  provider: ProviderSchema,
  status: Type.String(),
  amount: Money,
  qrCode: Type.Union([Type.String(), Type.Null()]),
  qrCodeBase64: Type.Union([Type.String(), Type.Null()]),
  checkoutUrl: Type.Union([Type.String(), Type.Null()]),
  expiresAt: Type.Union([Type.String(), Type.Null()]),
})

const CreatePaymentBody = Type.Object({
  orderId: Uuid,
  provider: Type.Optional(ProviderSchema),
  method: MethodSchema,
})

/** Opções de pagamento visíveis ao checkout — nunca inclui segredo. */
const PaymentOptions = Type.Object({
  defaultProvider: Type.Union([Type.String(), Type.Null()]),
  allowOnDelivery: Type.Boolean(),
  providers: Type.Array(Type.String()),
})

interface SettingsRow {
  default_provider: ProviderName | null
  mercadopago_access_token: string | null
  mercadopago_webhook_secret: string | null
  stripe_secret_key: string | null
  stripe_webhook_secret: string | null
  asaas_api_key: string | null
  asaas_webhook_token: string | null
}

/** Contrato: (row) -> ProviderCredentials — monta apenas o que está configurado. */
export function toCredentials(row: SettingsRow | null): ProviderCredentials {
  if (!row) return {}
  return {
    ...(row.mercadopago_access_token && row.mercadopago_webhook_secret
      ? {
          mercadopago: {
            accessToken: row.mercadopago_access_token,
            webhookSecret: row.mercadopago_webhook_secret,
          },
        }
      : {}),
    ...(row.stripe_secret_key && row.stripe_webhook_secret
      ? { stripe: { secretKey: row.stripe_secret_key, webhookSecret: row.stripe_webhook_secret } }
      : {}),
    ...(row.asaas_api_key && row.asaas_webhook_token
      ? { asaas: { apiKey: row.asaas_api_key, webhookToken: row.asaas_webhook_token } }
      : {}),
  }
}

const SETTINGS_COLUMNS =
  'tenant_id, default_provider, mercadopago_access_token, mercadopago_webhook_secret, stripe_secret_key, stripe_webhook_secret, asaas_api_key, asaas_webhook_token'

const paymentRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/public/payment-options',
    {
      schema: {
        tags: ['pagamentos'],
        description: 'Formas de pagamento disponíveis no estabelecimento.',
        querystring: Type.Object({ tenantSlug: Slug }),
        response: { 200: PaymentOptions, 404: ErrorResponse, 429: ErrorResponse },
      },
    },
    async (request) => {
      const { data: tenant } = await request.supabase
        .from('tenants')
        .select('id')
        .eq('slug', request.query.tenantSlug)
        .eq('is_active', true)
        .maybeSingle()

      if (!tenant) throw app.httpErrors.notFound('Estabelecimento não encontrado')

      const { data } = await request.supabase.rpc('tenant_payment_options', {
        p_tenant_id: tenant.id,
      })

      const options = (data ?? {}) as Record<string, unknown>
      return {
        defaultProvider: (options.defaultProvider as string | null) ?? null,
        allowOnDelivery: options.allowOnDelivery === undefined ? true : Boolean(options.allowOnDelivery),
        providers: Array.isArray(options.providers) ? (options.providers as string[]) : [],
      }
    },
  )

  app.post(
    '/payments',
    {
      onRequest: app.requireAuth,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['pagamentos'],
        description: 'Cria a cobrança on-line de um pedido no gateway do estabelecimento.',
        body: CreatePaymentBody,
        response: { 201: PaymentResult, ...StandardErrors },
      },
    },
    async (request, reply) => {
      // A RLS garante que o pedido seja do próprio cliente (ou do tenant do
      // funcionário); o valor cobrado vem do banco, nunca do cliente.
      const { data: order } = await request.supabase
        .from('orders')
        .select('id, tenant_id, order_number, total, payment_status, customer_id')
        .eq('id', request.body.orderId)
        .maybeSingle()

      if (!order) throw app.httpErrors.notFound('Pedido não encontrado')
      if (order.payment_status === 'paid') {
        throw app.httpErrors.conflict('Este pedido já está pago.')
      }

      // Credenciais só existem para o service_role.
      const { data: settings } = await app.supabaseAdmin
        .from('payment_settings')
        .select(SETTINGS_COLUMNS)
        .eq('tenant_id', order.tenant_id)
        .maybeSingle()

      const credentials = toCredentials(settings as SettingsRow | null)
      const providerName = (request.body.provider ??
        (settings as SettingsRow | null)?.default_provider) as ProviderName | undefined

      if (!providerName) {
        throw app.httpErrors.badRequest('Este estabelecimento não tem pagamento on-line configurado.')
      }

      let provider
      try {
        provider = resolveProvider(providerName, credentials)
      } catch (error) {
        throw app.httpErrors.badRequest((error as Error).message)
      }

      const { data: customer } = order.customer_id
        ? await app.supabaseAdmin
            .from('customers')
            .select('name, whatsapp, auth_user_id')
            .eq('id', order.customer_id)
            .maybeSingle()
        : { data: null }

      const methodColumn = request.body.method === 'boleto' ? 'other' : request.body.method

      // Quantas cobranças já existem para este pedido e método define a
      // tentativa atual. Dois cliques (ou um retry de rede) na MESMA tentativa
      // contam o mesmo total, produzem a mesma chave, e o gateway devolve a
      // cobrança existente em vez de criar outra; uma nova tentativa
      // deliberada, depois de a anterior falhar ou expirar, conta mais uma e
      // gera cobrança nova — que é o comportamento desejado.
      const { count: previousAttempts } = await app.supabaseAdmin
        .from('payments')
        .select('id', { count: 'exact', head: true })
        .eq('order_id', order.id)
        .eq('method', methodColumn)

      try {
        const result = await provider.createPayment({
          amount: Number(order.total),
          method: request.body.method,
          description: `Pedido nº ${order.order_number}`,
          orderId: order.id,
          orderNumber: Number(order.order_number),
          payer: {
            email: request.auth!.email ?? 'sem-email@gastrosync.local',
            name: (customer?.name as string | null) ?? null,
          },
          idempotencyKey: `${order.id}:${request.body.method}:${previousAttempts ?? 0}`,
        })

        const { data: saved, error } = await app.supabaseAdmin
          .from('payments')
          .insert({
            tenant_id: order.tenant_id,
            order_id: order.id,
            provider: providerName,
            provider_payment_id: result.providerPaymentId,
            method: methodColumn,
            status: result.status,
            amount: Number(order.total),
            qr_code: result.qrCode,
            qr_code_base64: result.qrCodeBase64,
            checkout_url: result.checkoutUrl,
            expires_at: result.expiresAt,
            raw: result.raw ?? {},
          })
          .select('id')
          .single()

        if (error) throw app.httpErrors.internalServerError(error.message)

        return reply.status(201).send({
          id: saved.id,
          provider: providerName,
          status: result.status,
          amount: Number(order.total),
          qrCode: result.qrCode,
          qrCodeBase64: result.qrCodeBase64,
          checkoutUrl: result.checkoutUrl,
          expiresAt: result.expiresAt,
        })
      } catch (error) {
        if (error instanceof PaymentProviderError) {
          request.log.error({ err: error, providerResponse: error.providerResponse }, 'Gateway recusou')
          throw app.httpErrors.badGateway('O provedor de pagamento recusou a cobrança.')
        }
        throw error
      }
    },
  )
}

export default paymentRoutes
