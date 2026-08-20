'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'

/**
 * Sair do painel. Depois de encerrar a sessão, `refresh()` é obrigatório: sem
 * ele o layout do servidor continuaria servindo a versão renderizada com a
 * sessão antiga em cache, e a tela seguiria aberta para quem já saiu.
 */
export function SignOutButton({ slug, label = 'Sair' }: { slug: string; label?: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function signOut() {
    setBusy(true)
    await createClient().auth.signOut()
    router.replace(`/${slug}/painel/entrar`)
    router.refresh()
  }

  return (
    <Button variant="outline" size="sm" disabled={busy} onClick={() => void signOut()}>
      {busy ? 'Saindo…' : label}
    </Button>
  )
}
