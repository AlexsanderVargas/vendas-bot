import { getPublicMenu } from '@vendas-bot/shared'
import { createClient } from '@/lib/supabase/server'
import { ComandaManager } from '@/components/painel/comanda-manager'

export default async function ComandasPage() {
  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  const tenantId = (auth.user?.app_metadata as { tenant_id?: string } | null)?.tenant_id

  const { data: tenant } = await supabase
    .from('tenants')
    .select('slug')
    .eq('id', tenantId ?? '')
    .maybeSingle()

  const menu = tenant ? await getPublicMenu(supabase, tenant.slug) : null
  const products = menu
    ? [...menu.categories.flatMap((category) => category.products), ...menu.uncategorized]
    : []

  return (
    <main>
      <h1 className="mb-6 text-2xl font-bold tracking-tight">Comandas</h1>
      {products.length === 0 ? (
        <p className="text-sm text-muted-foreground">Cadastre produtos no cardápio para lançar comandas.</p>
      ) : (
        <ComandaManager
          products={products.map((product) => ({
            id: product.id,
            name: product.name,
            price: product.price,
            optionGroups: product.optionGroups.map((group) => ({
              id: group.id,
              name: group.name,
              selectionType: group.selectionType,
              minSelect: group.minSelect,
              maxSelect: group.maxSelect,
              options: group.options.map((option) => ({ ...option })),
            })),
          }))}
        />
      )}
    </main>
  )
}
