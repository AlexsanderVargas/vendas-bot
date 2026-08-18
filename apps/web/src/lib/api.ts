import { createClient } from '@/lib/supabase/client'

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3333'

export class ApiError extends Error {
  constructor(
    override readonly message: string,
    readonly statusCode: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * Contrato: (path, init?) -> Promise<T>
 * Chama a API do backend anexando o access token da sessão do Supabase.
 * Erros viram ApiError com a mensagem do contrato ErrorResponse.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const supabase = createClient()
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token

  const response = await fetch(`${BASE_URL}/api/v1${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  })

  if (response.status === 204) return null as T

  const payload = (await response.json().catch(() => null)) as
    | { message?: string }
    | T
    | null

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'message' in payload && payload.message
        ? String(payload.message)
        : `Falha na requisição (${response.status})`
    throw new ApiError(message, response.status)
  }

  return payload as T
}
