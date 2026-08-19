import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

/**
 * O painel passou a viver sob o slug do estabelecimento (`/lancheria/painel`).
 * Este atalho existe para os endereços antigos que a equipe já salvou no
 * navegador: descobre o estabelecimento de quem está logado e redireciona,
 * preservando o módulo que a pessoa tentou abrir.
 */
export default async function PainelLegado({
  params,
}: {
  params: Promise<{ caminho?: string[] }>
}) {
  const { caminho } = await params
  const supabase = await createClient()
  const { data: sessao } = await supabase.auth.getUser()

  const destino = caminho?.length ? `/${caminho.join('/')}` : ''

  if (sessao.user) {
    const { data: vinculo } = await supabase
      .from('users')
      .select('tenant_id')
      .eq('id', sessao.user.id)
      .maybeSingle()

    if (vinculo) {
      const { data: tenant } = await supabase
        .from('tenants')
        .select('slug')
        .eq('id', vinculo.tenant_id)
        .maybeSingle()

      if (tenant) redirect(`/${String(tenant.slug)}/painel${destino}`)
    }
  }

  // Sem sessão não há como adivinhar o estabelecimento — e mandar para uma
  // tela de login genérica seria mentir sobre onde a equipe entra agora.
  return (
    <main className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-24 text-center">
      <h1 className="text-xl font-semibold">O painel mudou de endereço</h1>
      <p className="text-sm text-muted-foreground">
        Cada estabelecimento tem o próprio painel, no mesmo endereço do cardápio:{' '}
        <code>/nome-do-estabelecimento/painel</code>.
      </p>
      <Link href="/" className="text-sm underline underline-offset-4">
        Voltar ao início
      </Link>
    </main>
  )
}
