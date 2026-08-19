/**
 * Carga e validação da configuração de ambiente.
 * Falha rápido no boot: variável obrigatória ausente derruba o processo com
 * mensagem explícita, em vez de erro obscuro na primeira requisição.
 */
export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production'
  readonly port: number
  readonly host: string
  readonly logLevel: string
  readonly corsOrigins: readonly string[]
  readonly supabaseUrl: string
  readonly supabaseAnonKey: string
  readonly supabaseServiceRoleKey: string
  /** Segredo HS256 (projetos legados). Vazio => verificação via JWKS. */
  readonly supabaseJwtSecret: string
  /**
   * Endereço público do frontend. Entra nos links que o Supabase envia por
   * e-mail (convite de funcionário, recuperação de senha): sem ele, o convite
   * levaria para o localhost de quem subiu o servidor.
   */
  readonly webAppUrl: string
  /** Intervalo do polling de marketplaces no worker (segundos). */
  readonly marketplacePollSeconds: number
  /** Intervalo da fila fiscal no worker (segundos). */
  readonly fiscalPollSeconds: number
  readonly rateLimitMax: number
  readonly rateLimitWindow: string
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]
  if (!value) throw new Error(`Variável de ambiente obrigatória ausente: ${key}`)
  return value
}

function intOr(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = (env.NODE_ENV ?? 'development') as AppConfig['nodeEnv']
  return {
    nodeEnv,
    port: intOr(env.PORT, 3333),
    host: env.HOST ?? '0.0.0.0',
    logLevel: env.LOG_LEVEL ?? (nodeEnv === 'test' ? 'silent' : 'info'),
    corsOrigins: (env.CORS_ORIGINS ?? 'http://localhost:3000')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    supabaseUrl: required(env, 'SUPABASE_URL'),
    supabaseAnonKey: required(env, 'SUPABASE_ANON_KEY'),
    supabaseServiceRoleKey: required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
    supabaseJwtSecret: env.SUPABASE_JWT_SECRET ?? '',
    webAppUrl: (env.WEB_APP_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
    // 30s é o intervalo que o iFood recomenda para o polling de eventos.
    marketplacePollSeconds: intOr(env.MARKETPLACE_POLL_SECONDS, 30),
    fiscalPollSeconds: intOr(env.FISCAL_POLL_SECONDS, 60),
    rateLimitMax: intOr(env.RATE_LIMIT_MAX, 100),
    rateLimitWindow: env.RATE_LIMIT_WINDOW ?? '1 minute',
  }
}
