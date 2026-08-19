/**
 * Identidade da equipe: usuário ou e-mail.
 *
 * O Supabase Auth identifica todo usuário por e-mail, mas garçom e cozinheiro
 * frequentemente não têm um. Para eles o estabelecimento cria um NOME DE
 * USUÁRIO, e o endereço técnico é derivado dele com o slug da loja.
 *
 * A derivação vive aqui, compartilhada, por um motivo de segurança: o
 * navegador monta o mesmo endereço que o backend gravou, então entrar não
 * exige um endpoint de "qual o e-mail do usuário fulano?" — endpoint que
 * serviria de lista telefônica da equipe para qualquer um de fora.
 *
 * O domínio é reservado e não recebe e-mail: conta de usuário não tem
 * recuperação por e-mail, e sim senha nova gerada por quem administra.
 */
export const STAFF_LOGIN_DOMAIN = 'equipe.gastrosync.app'

/** Formato do nome de usuário. Igual ao CHECK de public.users.login. */
const LOGIN_PATTERN = /^[a-z][a-z0-9._-]{2,29}$/

/**
 * Contrato: (input) -> string | null
 * Normaliza para minúsculas e devolve null quando o formato não serve.
 */
export function normalizeStaffLogin(input: string): string | null {
  const normalized = input.trim().toLowerCase()
  return LOGIN_PATTERN.test(normalized) ? normalized : null
}

/**
 * Contrato: (input) -> boolean
 * Distingue as duas formas de identificação. A presença de '@' é o critério:
 * o nome de usuário não aceita esse caractere.
 */
export function isEmailIdentifier(input: string): boolean {
  return input.includes('@')
}

/**
 * Contrato: (login, tenantSlug) -> string
 * Endereço técnico da conta de usuário. Determinístico e estável: mudar esta
 * regra deixaria a equipe inteira sem conseguir entrar.
 */
export function staffLoginEmail(login: string, tenantSlug: string): string {
  return `${login}@${tenantSlug}.${STAFF_LOGIN_DOMAIN}`
}

/**
 * Contrato: (identifier, tenantSlug) -> string | null
 * Resolve o que a pessoa digitou na tela de entrada para o endereço com que o
 * Supabase Auth vai autenticar. Null quando o usuário está fora do formato.
 */
export function resolveStaffEmail(identifier: string, tenantSlug: string): string | null {
  const trimmed = identifier.trim()
  if (isEmailIdentifier(trimmed)) return trimmed.toLowerCase()

  const login = normalizeStaffLogin(trimmed)
  return login ? staffLoginEmail(login, tenantSlug) : null
}
