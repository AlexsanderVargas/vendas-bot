import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { createClient } from '@/lib/supabase/server'
import { SignOutButton } from '@/components/painel/sign-out-button'

/** Itens do painel interno. Cresce a cada módulo entregue. */
const NAV = [
  { path: '', label: 'Visão geral' },
  { path: '/insumos', label: 'Insumos' },
  { path: '/salao', label: 'Salão' },
  { path: '/comandas', label: 'Comandas' },
  { path: '/cozinha', label: 'Cozinha' },
  { path: '/caixa', label: 'Caixa' },
  { path: '/financeiro', label: 'Financeiro' },
  { path: '/relatorios', label: 'Relatórios' },
  { path: '/integracoes', label: 'Integrações' },
  { path: '/fiscal', label: 'Fiscal' },
  { path: '/estoque', label: 'Estoque' },
  { path: '/fichas', label: 'Fichas técnicas' },
  { path: '/fornecedores', label: 'Fornecedores' },
  { path: '/identidade', label: 'Identidade visual' },
  { path: '/midias', label: 'Mídias' },
  { path: '/equipe', label: 'Equipe' },
]

interface LayoutProps {
  children: ReactNode
  params: Promise<{ slug: string }>
}

/**
 * Guarda do painel.
 *
 * O vínculo é conferido NO BANCO, não no claim do JWT. O claim diz de qual
 * estabelecimento a pessoa é, mas não diz se ela ainda está ativa: um
 * funcionário demitido continua com um token válido por até uma hora, e antes
 * desta verificação ele abria o painel inteiro nesse intervalo.
 *
 * A leitura funciona mesmo para quem tem o claim desatualizado porque a policy
 * `users_select` libera a própria linha (`id = auth.uid()`).
 */
export default async function PainelLayout({ children, params }: LayoutProps) {
  const { slug } = await params
  const supabase = await createClient()

  const { data: sessao } = await supabase.auth.getUser()
  if (!sessao.user) redirect(`/${slug}/painel/entrar`)

  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, name')
    .eq('slug', slug)
    .maybeSingle()
  if (!tenant) notFound()

  const { data: vinculo } = await supabase
    .from('users')
    .select('tenant_id, is_active, must_change_password, name')
    .eq('id', sessao.user.id)
    .maybeSingle()

  if (!vinculo || vinculo.tenant_id !== tenant.id || vinculo.is_active !== true) {
    return (
      <main className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-24 text-center">
        <h1 className="text-xl font-semibold">Acesso restrito</h1>
        <p className="text-sm text-muted-foreground">
          {!vinculo
            ? 'Sua conta não está vinculada a nenhum estabelecimento. Se você é cliente, use o cardápio.'
            : vinculo.tenant_id !== tenant.id
              ? `Sua conta é de outro estabelecimento e não tem acesso ao painel de ${String(tenant.name)}.`
              : 'Seu acesso foi desativado. Fale com quem administra o estabelecimento.'}
        </p>
        <div className="flex gap-2">
          <SignOutButton slug={slug} label="Entrar com outra conta" />
          <Link
            href={`/${slug}`}
            className="inline-flex h-9 items-center rounded-lg border border-border px-3 text-sm hover:bg-muted"
          >
            Ir para o cardápio
          </Link>
        </div>
      </main>
    )
  }

  // Senha ainda é a temporária que passou pela mão do gerente: nenhuma tela do
  // painel abre antes da troca.
  if (vinculo.must_change_password === true) redirect(`/${slug}/painel/definir-senha`)

  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-6 px-4 py-6 md:flex-row">
      <nav aria-label="Painel" className="md:w-52 md:shrink-0">
        <div className="mb-4 hidden md:block">
          <p className="text-sm font-semibold">{String(tenant.name)}</p>
          <p className="text-xs text-muted-foreground">{String(vinculo.name)}</p>
        </div>
        <ul className="flex gap-2 overflow-x-auto md:flex-col md:overflow-visible">
          {NAV.map((item) => (
            <li key={item.path}>
              <Link
                href={`/${slug}/painel${item.path}`}
                className="inline-block whitespace-nowrap rounded-lg px-3 py-2 text-sm hover:bg-muted"
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
        <div className="mt-4 hidden md:block">
          <SignOutButton slug={slug} />
        </div>
      </nav>
      <div className="flex-1">{children}</div>
    </div>
  )
}
