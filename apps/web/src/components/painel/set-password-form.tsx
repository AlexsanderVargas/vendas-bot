'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { apiFetch, ApiError } from '@/lib/api'

/** Mínimo exigido também pelo contrato de PUT /me/senha. */
const MIN_LENGTH = 8

/**
 * Troca de senha do funcionário: primeiro acesso (senha temporária dada pelo
 * gerente), convite por e-mail e recuperação caem todos aqui.
 *
 * A troca corre pelo backend, não por supabase.auth.updateUser: só o servidor
 * pode baixar a obrigação de trocar a senha. Fosse essa marca editável pelo
 * próprio usuário, bastaria limpá-la para continuar usando a senha temporária.
 */
export function SetPasswordForm({ slug }: { slug: string }) {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)

    if (password.length < MIN_LENGTH) {
      setError(`A senha precisa ter pelo menos ${MIN_LENGTH} caracteres.`)
      return
    }
    if (password !== confirmation) {
      setError('As duas senhas não são iguais.')
      return
    }

    setBusy(true)
    try {
      await apiFetch<{ mustChangePassword: boolean }>('/me/senha', {
        method: 'PUT',
        body: JSON.stringify({ password }),
      })
      router.replace(`/${slug}/painel`)
      router.refresh()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível trocar a senha.')
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Nova senha
        <Input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          minLength={MIN_LENGTH}
          required
        />
      </label>

      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Repita a nova senha
        <Input
          type="password"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          autoComplete="new-password"
          minLength={MIN_LENGTH}
          required
        />
      </label>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <Button type="submit" disabled={busy}>
        {busy ? 'Salvando…' : 'Salvar senha'}
      </Button>
    </form>
  )
}
