import fp from 'fastify-plugin'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AppConfig } from '../config.js'

declare module 'fastify' {
  interface FastifyInstance {
    /** Cliente service_role: IGNORA RLS. Usar só em webhooks e rotinas admin. */
    supabaseAdmin: SupabaseClient
    /** Cliente anônimo: sujeito às políticas públicas (cardápio). */
    supabaseAnon: SupabaseClient
  }
  interface FastifyRequest {
    /**
     * Cliente Supabase no contexto do usuário da requisição — repassa o JWT,
     * então TODA consulta passa pelas políticas de RLS do PBI 1.
     * Sem token, equivale ao cliente anônimo.
     */
    supabase: SupabaseClient
  }
}

export interface SupabasePluginOptions {
  config: AppConfig
}

/** Contrato: registra supabaseAdmin/supabaseAnon na instância e request.supabase por requisição. */
export default fp<SupabasePluginOptions>(
  async function supabasePlugin(app: FastifyInstance, opts: SupabasePluginOptions) {
    const { config } = opts
    const noPersist = { auth: { persistSession: false, autoRefreshToken: false } }

    const admin = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, noPersist)
    const anon = createClient(config.supabaseUrl, config.supabaseAnonKey, noPersist)

    app.decorate('supabaseAdmin', admin)
    app.decorate('supabaseAnon', anon)
    app.decorateRequest('supabase', null as unknown as SupabaseClient)

    app.addHook('onRequest', async (request: FastifyRequest) => {
      const token = extractBearer(request.headers.authorization)
      request.supabase = token
        ? createClient(config.supabaseUrl, config.supabaseAnonKey, {
            ...noPersist,
            global: { headers: { Authorization: `Bearer ${token}` } },
          })
        : anon
    })
  },
  { name: 'supabase' },
)

export function extractBearer(header: string | undefined): string | null {
  if (!header) return null
  const [scheme, token] = header.split(' ')
  if (!token || scheme?.toLowerCase() !== 'bearer') return null
  return token
}
