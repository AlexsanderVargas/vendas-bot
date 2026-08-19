import { createClient } from '@/lib/supabase/server'
import { IntegrationsManager } from '@/components/painel/integrations-manager'

export default async function IntegracoesPage() {
  const supabase = await createClient()
  const { data: products } = await supabase
    .from('products')
    .select('id, name')
    .eq('is_active', true)
    .order('name')

  return (
    <main>
      <h1 className="mb-2 text-2xl font-bold tracking-tight">Integrações</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Pedidos do iFood e do Uber Eats entram no mesmo fluxo dos pedidos próprios: aparecem na
        cozinha, baixam estoque e entram nos relatórios.
      </p>
      <IntegrationsManager products={products ?? []} />
    </main>
  )
}
