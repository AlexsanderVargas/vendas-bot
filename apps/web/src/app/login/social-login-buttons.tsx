'use client'

import { useSearchParams } from 'next/navigation'
import { useState } from 'react'
import type { Provider } from '@supabase/supabase-js'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'

/**
 * Provedores do CLIENTE. Só entram contas que consumidor de delivery já tem:
 * GitHub é conta de desenvolvedor e não pertence a esta porta. A equipe do
 * estabelecimento entra por outro caminho, com usuário e senha.
 */
const PROVIDERS: ReadonlyArray<{ id: Provider; label: string }> = [
  { id: 'google', label: 'Continuar com Google' },
  { id: 'facebook', label: 'Continuar com Facebook' },
  { id: 'azure', label: 'Continuar com Outlook' },
]

interface SocialLoginButtonsProps {
  /** Estabelecimento do cadastro, quando a tela já vive dentro de um slug. */
  tenantSlug?: string
  /** Destino após entrar, quando não vier por query string. */
  defaultNext?: string
}

export function SocialLoginButtons({ tenantSlug, defaultNext }: SocialLoginButtonsProps = {}) {
  const searchParams = useSearchParams()
  const [pending, setPending] = useState<Provider | null>(null)
  const [error, setError] = useState<string | null>(null)

  const next = searchParams.get('next') ?? defaultNext ?? '/'
  const tenant = searchParams.get('tenant') ?? tenantSlug ?? null

  // O /auth/callback devolve a falha do provedor aqui. Sem exibir, quem tenta
  // entrar e volta para a mesma tela não descobre que houve erro nenhum.
  const callbackError = searchParams.get('erro')

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
      {error || callbackError ? (
        <p role="alert" className="text-sm text-destructive">
          {error
            ? `Não foi possível iniciar o login: ${error}`
            : callbackError === 'codigo-ausente'
              ? 'O link de entrada expirou ou já foi usado. Tente novamente.'
              : `Não foi possível concluir o login: ${callbackError}`}
        </p>
      ) : null}
    </div>
  )
}
