'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { resolveStaffEmail } from '@vendas-bot/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { createClient } from '@/lib/supabase/client'

/**
 * Entrada da equipe. Aceita e-mail ou nome de usuário: o endereço técnico da
 * conta de usuário é derivado aqui mesmo, com o slug da página, pela mesma
 * função que o servidor usou para criar a conta. Sem consulta ao servidor —
 * um endpoint "qual o e-mail do fulano?" seria a lista da equipe aberta para
 * qualquer um de fora.
 */
export function StaffLoginForm({ slug }: { slug: string }) {
  const router = useRouter()
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [recovering, setRecovering] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setMessage(null)
    setBusy(true)

    const email = resolveStaffEmail(identifier, slug)
    if (!email) {
      setError('Informe o e-mail ou o nome de usuário cadastrado.')
      setBusy(false)
      return
    }

    const supabase = createClient()
    const { data, error: signInError } = await supabase.auth.signInWithPassword({ email, password })

    // Mensagem única para usuário inexistente e senha errada: distinguir os
    // dois casos entrega de graça a lista de quem trabalha aqui.
    if (signInError || !data.user) {
      setError('Usuário ou senha incorretos.')
      setBusy(false)
      return
    }

    // Entrar e cair num painel vazio é pior que a recusa: confere o vínculo
    // antes de seguir, e encerra a sessão se a conta for de outra loja.
    const [{ data: tenant }, { data: vinculo }] = await Promise.all([
      supabase.from('tenants').select('id').eq('slug', slug).maybeSingle(),
      supabase.from('users').select('tenant_id, is_active').eq('id', data.user.id).maybeSingle(),
    ])

    if (!tenant || !vinculo || vinculo.tenant_id !== tenant.id || vinculo.is_active !== true) {
      await supabase.auth.signOut()
      setError('Esta conta não tem acesso ao painel deste estabelecimento.')
      setBusy(false)
      return
    }

    router.replace(`/${slug}/painel`)
    router.refresh()
  }

  async function recover(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setMessage(null)

    const email = identifier.trim()
    if (!email.includes('@')) {
      // Conta de usuário não tem caixa de entrada: o endereço é técnico.
      setError(
        'Conta de usuário não tem recuperação por e-mail. Peça uma nova senha a quem administra o estabelecimento.',
      )
      return
    }

    setBusy(true)
    const supabase = createClient()
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(
        `/${slug}/painel/definir-senha`,
      )}`,
    })
    setBusy(false)

    if (resetError) {
      setError('Não foi possível enviar o e-mail de recuperação agora.')
      return
    }
    // Resposta igual exista ou não a conta: confirmar a existência de um
    // e-mail é o primeiro passo de quem monta uma lista para atacar.
    setMessage('Se houver conta com esse e-mail, o link de troca de senha chegou na caixa dela.')
  }

  return (
    <form onSubmit={recovering ? recover : signIn} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        {recovering ? 'E-mail da conta' : 'Usuário ou e-mail'}
        <Input
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          placeholder={recovering ? 'voce@exemplo.com' : 'caixa1'}
        />
      </label>

      {recovering ? null : (
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Senha
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
      )}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {message ? <p className="text-sm">{message}</p> : null}

      <Button type="submit" disabled={busy}>
        {busy ? 'Aguarde…' : recovering ? 'Enviar link de troca' : 'Entrar'}
      </Button>

      <button
        type="button"
        onClick={() => {
          setRecovering(!recovering)
          setError(null)
          setMessage(null)
        }}
        className="self-center text-sm text-muted-foreground underline underline-offset-4"
      >
        {recovering ? 'Voltar para a entrada' : 'Esqueci minha senha'}
      </button>
    </form>
  )
}
