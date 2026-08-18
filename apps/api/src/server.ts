import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import sensible from '@fastify/sensible'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { loadConfig, type AppConfig } from './config.js'
import supabasePlugin from './plugins/supabase.js'
import authPlugin from './plugins/auth.js'
import errorsPlugin from './plugins/errors.js'
import healthRoutes from './modules/health/routes.js'
import meRoutes from './modules/me/routes.js'
import menuRoutes from './modules/menu/routes.js'
import addressRoutes from './modules/addresses/routes.js'
import cartRoutes from './modules/cart/routes.js'
import orderRoutes from './modules/orders/routes.js'

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig
  }
}

export interface BuildServerOptions {
  config?: AppConfig
}

/**
 * Contrato: (opts?) -> Promise<FastifyInstance>
 * Monta a aplicação sem escutar porta — usado tanto por index.ts quanto pelos
 * testes via app.inject().
 */
export async function buildServer(opts: BuildServerOptions = {}): Promise<FastifyInstance> {
  const config = opts.config ?? loadConfig()

  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
    ajv: { customOptions: { coerceTypes: 'array', removeAdditional: 'all' } },
  }).withTypeProvider<TypeBoxTypeProvider>()

  app.decorate('config', config)

  await app.register(sensible)
  await app.register(helmet, { contentSecurityPolicy: false })

  // CORS rigoroso: apenas origens explicitamente listadas.
  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true) // apps nativos / curl
      callback(null, config.corsOrigins.includes(origin))
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  })

  await app.register(errorsPlugin)
  await app.register(supabasePlugin, { config })
  await app.register(authPlugin, { config })

  // Registrado DEPOIS do auth de propósito: o hook onRequest do auth precisa
  // ter resolvido request.auth para que a chave seja o usuário, não o IP
  // (vários clientes atrás do mesmo NAT compartilhariam a cota).
  await app.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindow,
    keyGenerator: (request) => request.auth?.userId ?? request.ip,
  })

  await app.register(
    async (api) => {
      await api.register(healthRoutes)
      await api.register(meRoutes)
      await api.register(menuRoutes)
      await api.register(addressRoutes)
      await api.register(cartRoutes)
      await api.register(orderRoutes)
    },
    { prefix: '/api/v1' },
  )

  return app
}
