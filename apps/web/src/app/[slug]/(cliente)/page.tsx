import { notFound } from 'next/navigation'
import { getPublicMenu } from '@vendas-bot/shared'
import { createClient } from '@/lib/supabase/server'
import { MenuBrowser } from '@/components/menu/menu-browser'
import { BrandedHeader } from '@/components/branding/branded-header'
import { getBranding } from '@/lib/branding'

interface PageProps {
  params: Promise<{ slug: string }>
}

export default async function MenuPage({ params }: PageProps) {
  const { slug } = await params
  const supabase = await createClient()
  const [menu, branding] = await Promise.all([getPublicMenu(supabase, slug), getBranding(slug)])

  if (!menu || !branding) notFound()

  const sections = [
    ...menu.categories,
    ...(menu.uncategorized.length > 0
      ? [{ id: 'sem-categoria', name: 'Outros', description: null, products: menu.uncategorized }]
      : []),
  ].filter((section) => section.products.length > 0)

  return (
    <main className="mx-auto max-w-3xl px-4 pb-24">
      <BrandedHeader tenant={menu.tenant} branding={branding} />
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
