import fp from 'fastify-plugin'
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose'
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { AppConfig } from '../config.js'
import { extractBearer } from './supabase.js'

/** Identidade resolvida a partir do JWT do Supabase Auth. */
export interface AuthContext {
  readonly userId: string
  readonly email: string | null
  /** tenant_id do claim app_metadata (apenas funcionários o possuem). */
  readonly tenantId: string | null
  readonly claims: JWTPayload
  readonly token: string
}

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Exige usuário autenticado (401 caso contrário).
     * Registrar como `onRequest` nas rotas: o hook de validação de schema do
     * Fastify roda ANTES do preHandler, então um corpo inválido sem token
     * responderia 400 em vez de 401.
     */
    requireAuth: preHandlerHookHandler
    /** preHandler: exige funcionário vinculado a um tenant (403 caso contrário). */
    requireStaff: preHandlerHookHandler
    /** Fábrica de preHandler que exige uma permissão RBAC (ex.: 'orders.create'). */
    requirePermission: (permission: string) => preHandlerHookHandler
  }
  interface FastifyRequest {
    auth: AuthContext | null
    /** Atalho: lança 403 se não houver funcionário autenticado. */
    requireTenantId: () => string
  }
}

export interface AuthPluginOptions {
  config: AppConfig
}

interface AppMetadata {
  tenant_id?: string
}

export default fp<AuthPluginOptions>(
  async function authPlugin(app: FastifyInstance, opts: AuthPluginOptions) {
    const { config } = opts

    // Projetos legados assinam com segredo simétrico; os atuais expõem JWKS.
    const symmetricKey = config.supabaseJwtSecret
      ? new TextEncoder().encode(config.supabaseJwtSecret)
      : null
    const jwks: JWTVerifyGetKey | null = symmetricKey
      ? null
      : createRemoteJWKSet(new URL(`${config.supabaseUrl}/auth/v1/.well-known/jwks.json`))

    async function verify(token: string): Promise<JWTPayload> {
      const { payload } = symmetricKey
        ? await jwtVerify(token, symmetricKey)
        : await jwtVerify(token, jwks!)
      return payload
    }

    app.decorateRequest('auth', null)
    app.decorateRequest('requireTenantId', function (this: FastifyRequest): string {
      const tenantId = this.auth?.tenantId
      if (!tenantId) throw app.httpErrors.forbidden('Requer funcionário vinculado a um estabelecimento')
      return tenantId
    })

    // Resolve a identidade quando há token; requisições anônimas seguem com auth=null
    // (o cardápio público depende disso).
    app.addHook('onRequest', async (request: FastifyRequest) => {
      const token = extractBearer(request.headers.authorization)
      if (!token) return
      try {
        const claims = await verify(token)
        const appMetadata = (claims.app_metadata ?? {}) as AppMetadata
        request.auth = {
          userId: String(claims.sub),
          email: typeof claims.email === 'string' ? claims.email : null,
          tenantId: appMetadata.tenant_id ?? null,
          claims,
          token,
        }
      } catch (error) {
        request.log.debug({ err: error }, 'JWT inválido')
      }
    })

    app.decorate('requireAuth', async function (request: FastifyRequest) {
      if (!request.auth) throw app.httpErrors.unauthorized('Autenticação obrigatória')
    })

    app.decorate('requireStaff', async function (request: FastifyRequest) {
      if (!request.auth) throw app.httpErrors.unauthorized('Autenticação obrigatória')
      if (!request.auth.tenantId) {
        throw app.httpErrors.forbidden('Requer funcionário vinculado a um estabelecimento')
      }
    })

    app.decorate('requirePermission', (permission: string): preHandlerHookHandler => {
      return async function (request: FastifyRequest, _reply: FastifyReply) {
        if (!request.auth) throw app.httpErrors.unauthorized('Autenticação obrigatória')
        const tenantId = request.auth.tenantId
        if (!tenantId) throw app.httpErrors.forbidden('Requer funcionário vinculado a um estabelecimento')

        const { data, error } = await app.supabaseAdmin
          .from('users')
          .select('is_active, roles(permissions)')
          .eq('id', request.auth.userId)
          .eq('tenant_id', tenantId)
          .maybeSingle()

        if (error) throw app.httpErrors.internalServerError(error.message)
        if (!data || data.is_active !== true) {
          throw app.httpErrors.forbidden('Funcionário inativo ou não encontrado')
        }

        const role = data.roles as { permissions?: Record<string, boolean> } | null
        if (!hasPermission(role?.permissions ?? {}, permission)) {
          throw app.httpErrors.forbidden(`Permissão negada: ${permission}`)
        }
      }
    })
  },
  { name: 'auth', dependencies: ['supabase'] },
)

/**
 * Contrato: (permissions, permission) -> boolean
 * Resolve permissões com curinga. 'orders.create' é concedida por
 * '*', 'orders.*' ou 'orders.create'. Negação explícita (false) vence.
 */
export function hasPermission(
  permissions: Record<string, boolean>,
  permission: string,
): boolean {
  if (permissions[permission] === false) return false
  if (permissions[permission] === true) return true

  const segments = permission.split('.')
  for (let i = segments.length - 1; i > 0; i -= 1) {
    const wildcard = `${segments.slice(0, i).join('.')}.*`
    if (permissions[wildcard] === false) return false
    if (permissions[wildcard] === true) return true
  }
  return permissions['*'] === true
}
