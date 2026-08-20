import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { StaffLoginForm } from '@/components/painel/staff-login-form'
import { createClient } from '@/lib/supabase/server'

export const metadata = { title: 'Entrar no painel' }

/**
 * Fica FORA do grupo (interno) de propósito: dentro dele, a guarda mandaria
 * quem não tem sessão para esta mesma página, em laço infinito.
 */
export default async function EntrarPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const supabase = await createClient()

  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, name')
    .eq('slug', slug)
    .maybeSingle()
  if (!tenant) notFound()

  // Quem já é funcionário ativo daqui não precisa ver a tela de entrada.
  const { data: sessao } = await supabase.auth.getUser()
  if (sessao.user) {
    const { data: vinculo } = await supabase
      .from('users')
      .select('tenant_id, is_active')
      .eq('id', sessao.user.id)
      .maybeSingle()
    if (vinculo && vinculo.tenant_id === tenant.id && vinculo.is_active === true) {
      redirect(`/${slug}/painel`)
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md items-center px-6">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>{String(tenant.name)}</CardTitle>
          <CardDescription>
            Área da equipe. Entre com o usuário ou e-mail cadastrado pelo estabelecimento.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <StaffLoginForm slug={slug} />
          <p className="text-center text-sm text-muted-foreground">
            É cliente?{' '}
            <Link href={`/${slug}`} className="underline underline-offset-4">
              Veja o cardápio
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    </main>
  )
}
