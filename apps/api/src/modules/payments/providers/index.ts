import type { PaymentProvider } from './types.js'
import { createMercadoPagoProvider } from './mercadopago.js'
import { createStripeProvider } from './stripe.js'
import { createAsaasProvider } from './asaas.js'

export * from './types.js'
export * from './signature.js'
export { createMercadoPagoProvider, mapMercadoPagoStatus } from './mercadopago.js'
export { createStripeProvider, mapStripeStatus, toStripeAmount } from './stripe.js'
export { createAsaasProvider, mapAsaasStatus, toAsaasDueDate } from './asaas.js'

export type ProviderName = 'mercadopago' | 'stripe' | 'asaas'

export interface ProviderCredentials {
  readonly mercadopago?: { accessToken: string; webhookSecret: string }
  readonly stripe?: { secretKey: string; webhookSecret: string }
  readonly asaas?: { apiKey: string; webhookToken: string }
}

/**
 * Contrato: (name, credentials) -> PaymentProvider
 * Monta o provedor pedido. Lança se o estabelecimento não configurou as
 * credenciais — falhar aqui é melhor do que tentar cobrar sem chave.
 */
export function resolveProvider(
  name: ProviderName,
  credentials: ProviderCredentials,
): PaymentProvider {
  switch (name) {
    case 'mercadopago': {
      if (!credentials.mercadopago) throw new Error('Mercado Pago não configurado para este estabelecimento')
      return createMercadoPagoProvider(credentials.mercadopago)
    }
    case 'stripe': {
      if (!credentials.stripe) throw new Error('Stripe não configurada para este estabelecimento')
      return createStripeProvider(credentials.stripe)
    }
    case 'asaas': {
      if (!credentials.asaas) throw new Error('Asaas não configurado para este estabelecimento')
      return createAsaasProvider(credentials.asaas)
    }
  }
}
