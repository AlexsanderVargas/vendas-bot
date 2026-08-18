'use client'

import { useSearchParams } from 'next/navigation'
import { useState } from 'react'
import type { Provider } from '@supabase/supabase-js'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'

/** Provedores OAuth 2.0 habilitados no Supabase Auth. */
const PROVIDERS: ReadonlyArray<{ id: Provider; label: string }> = [
  { id: 'google', label: 'Continuar com Google' },
  { id: 'facebook', label: 'Continuar com Facebook' },
  { id: 'azure', label: 'Continuar com Outlook' },
  { id: 'github', label: 'Continuar com GitHub' },
]

export function SocialLoginButtons() {
  const searchParams = useSearchParams()
  const [pending, setPending] = useState<Provider | null>(null)
  const [error, setError] = useState<string | null>(null)

  const next = searchParams.get('next') ?? '/'
  const tenant = searchParams.get('tenant')

  async function signIn(provider: Provider) {
    setPending(provider)
    setError(null)

    const callback = new URL('/auth/callback', window.location.origin)
    callback.searchParams.set('next', next)
    if (tenant) callback.searchParams.set('tenant', tenant)

    const supabase = createClient()
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: callback.toString(),
        // 'azure' cobre contas Outlook/Microsoft; e-mail é necessário para o perfil.
        ...(provider === 'azure' ? { scopes: 'email openid profile' } : {}),
      },
    })

    if (oauthError) {
      setError(oauthError.message)
      setPending(null)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {PROVIDERS.map((provider) => (
        <Button
          key={provider.id}
          variant="outline"
          onClick={() => void signIn(provider.id)}
          disabled={pending !== null}
        >
          {pending === provider.id ? 'Redirecionando…' : provider.label}
        </Button>
      ))}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          Não foi possível iniciar o login: {error}
        </p>
      ) : null}
    </div>
  )
}
