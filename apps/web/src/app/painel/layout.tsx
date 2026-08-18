import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { createClient } from '@/lib/supabase/server'
import { ThemeStyle } from '@/components/branding/theme-style'
import { getBranding } from '@/lib/branding'

/** Itens do painel interno. Cresce a cada módulo entregue. */
const NAV = [
  { href: '/painel', label: 'Visão geral' },
  { href: '/painel/insumos', label: 'Insumos' },
  { href: '/painel/salao', label: 'Salão' },
  { href: '/painel/comandas', label: 'Comandas' },
  { href: '/painel/cozinha', label: 'Cozinha' },
  { href: '/painel/caixa', label: 'Caixa' },
  { href: '/painel/financeiro', label: 'Financeiro' },
  { href: '/painel/relatorios', label: 'Relatórios' },
  { href: '/painel/integracoes', label: 'Integrações' },
  { href: '/painel/fiscal', label: 'Fiscal' },
  { href: '/painel/estoque', label: 'Estoque' },
  { href: '/painel/fichas', label: 'Fichas técnicas' },
  { href: '/painel/fornecedores', label: 'Fornecedores' },
  { href: '/painel/identidade', label: 'Identidade visual' },
  { href: '/painel/midias', label: 'Mídias' },
  { href: '/painel/equipe', label: 'Equipe' },
]

export default async function PainelLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient()
  const { data } = await supabase.auth.getUser()

  if (!data.user) redirect('/login?next=/painel')

  // Só funcionário tem tenant_id no claim; cliente B2C cai fora do painel.
  const tenantId = (data.user.app_metadata as { tenant_id?: string } | null)?.tenant_id
  if (!tenantId) {
    return (
      <main className="mx-auto max-w-md px-4 py-24 text-center">
        <h1 className="mb-2 text-xl font-semibold">Acesso restrito</h1>
        <p className="text-sm text-muted-foreground">
          Esta área é do estabelecimento. Sua conta não está vinculada a nenhum.
        </p>
      </main>
    )
  }

  // O painel também veste a marca do estabelecimento: quem passa o dia nele
  // é a equipe do cliente, não a do SaaS.
  const { data: tenant } = await supabase
    .from('tenants')
    .select('slug')
    .eq('id', tenantId)
    .maybeSingle()
  const branding = tenant ? await getBranding(String(tenant.slug)) : null

  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-6 px-4 py-6 md:flex-row">
      {branding ? <ThemeStyle branding={branding} /> : null}
      <nav aria-label="Painel" className="md:w-52 md:shrink-0">
        <ul className="flex gap-2 overflow-x-auto md:flex-col md:overflow-visible">
          {NAV.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className="inline-block whitespace-nowrap rounded-lg px-3 py-2 text-sm hover:bg-muted"
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex-1">{children}</div>
    </div>
  )
}
