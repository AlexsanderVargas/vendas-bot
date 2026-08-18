import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { getPublicMenu } from '@vendas-bot/shared'
import { createClient } from '@/lib/supabase/server'
import { MenuBrowser } from '@/components/menu/menu-browser'
import { TenantHeader } from '@/components/menu/tenant-header'

interface PageProps {
  params: Promise<{ slug: string }>
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params
  const supabase = await createClient()
  const menu = await getPublicMenu(supabase, slug)
  if (!menu) return { title: 'Estabelecimento não encontrado' }
  return {
    title: `${menu.tenant.name} — Cardápio`,
    description: `Peça online no ${menu.tenant.name}.`,
  }
}

export default async function MenuPage({ params }: PageProps) {
  const { slug } = await params
  const supabase = await createClient()
  const menu = await getPublicMenu(supabase, slug)

  if (!menu) notFound()

  const sections = [
    ...menu.categories,
    ...(menu.uncategorized.length > 0
      ? [{ id: 'sem-categoria', name: 'Outros', description: null, products: menu.uncategorized }]
      : []),
  ].filter((section) => section.products.length > 0)

  return (
    <main className="mx-auto max-w-3xl px-4 pb-24">
      <TenantHeader tenant={menu.tenant} />
      {sections.length === 0 ? (
        <p className="py-16 text-center text-muted-foreground">
          Este cardápio ainda não tem itens publicados.
        </p>
      ) : (
        <MenuBrowser sections={sections} tenantSlug={menu.tenant.slug} />
      )}
    </main>
  )
}
