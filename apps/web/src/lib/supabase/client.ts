'use client'

import { createBrowserClient } from '@supabase/ssr'

/** Contrato: () -> SupabaseClient no contexto do navegador (sessão em cookies). */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}
