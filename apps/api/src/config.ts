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
    rateLimitMax: intOr(env.RATE_LIMIT_MAX, 100),
    rateLimitWindow: env.RATE_LIMIT_WINDOW ?? '1 minute',
  }
}
