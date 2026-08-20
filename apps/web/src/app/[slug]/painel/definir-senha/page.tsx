import { notFound, redirect } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { SetPasswordForm } from '@/components/painel/set-password-form'
import { createClient } from '@/lib/supabase/server'

export const metadata = { title: 'Definir senha' }

/**
 * Destino de três caminhos: primeiro acesso com senha temporária, convite por
 * e-mail e recuperação. Todos chegam aqui já com sessão — o convite e a
 * recuperação passam antes pelo /auth/callback, que troca o código por cookie.
 *
 * Fora do grupo (interno) porque a guarda do painel manda para cá quem ainda
 * está com a senha temporária: dentro dele, seria laço.
 */
export default async function DefinirSenhaPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const supabase = await createClient()

  const { data: tenant } = await supabase
    .from('tenants')
    .select('id')
    .eq('slug', slug)
    .maybeSingle()
  if (!tenant) notFound()

  const { data: sessao } = await supabase.auth.getUser()
  if (!sessao.user) redirect(`/${slug}/painel/entrar`)

  const { data: vinculo } = await supabase
    .from('users')
    .select('tenant_id, is_active, name')
    .eq('id', sessao.user.id)
    .maybeSingle()

  if (!vinculo || vinculo.tenant_id !== tenant.id || vinculo.is_active !== true) {
    redirect(`/${slug}/painel`)
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md items-center px-6">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Definir senha</CardTitle>
          <CardDescription>
            Olá, {String(vinculo.name)}. Escolha uma senha só sua — a temporária deixa de valer
            assim que você salvar.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SetPasswordForm slug={slug} />
        </CardContent>
      </Card>
    </main>
  )
}
