import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

/**
 * Contrato: () -> Promise<SupabaseClient> para Server Components, Route
 * Handlers e Server Actions. A sessão vive em cookies e as consultas seguem
 * sujeitas às políticas de RLS do usuário.
 */
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options)
            }
          } catch {
            // Server Component não pode escrever cookies: o middleware já
            // renova a sessão, então ignorar aqui é seguro.
          }
        },
      },
    },
  )
}
