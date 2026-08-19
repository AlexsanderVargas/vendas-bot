import { createClient } from '@/lib/supabase/server'
import { StockAlerts } from '@/components/painel/stock-alerts'

export default async function PainelHome() {
  const supabase = await createClient()

  const [{ count: pedidosAbertos }, { count: insumosCriticos }] = await Promise.all([
    supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .in('status', ['placed', 'confirmed', 'preparing', 'ready']),
    supabase.from('ingredients').select('id', { count: 'exact', head: true }).eq('is_active', true),
  ])

  return (
    <main>
      <h1 className="mb-6 text-2xl font-bold tracking-tight">Visão geral</h1>
      <dl className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-border p-4">
          <dt className="text-sm text-muted-foreground">Pedidos em andamento</dt>
          <dd className="text-3xl font-semibold">{pedidosAbertos ?? 0}</dd>
        </div>
        <div className="rounded-xl border border-border p-4">
          <dt className="text-sm text-muted-foreground">Insumos cadastrados</dt>
          <dd className="text-3xl font-semibold">{insumosCriticos ?? 0}</dd>
        </div>
      </dl>
      <section className="mt-8">
        <h2 className="mb-3 text-lg font-semibold">Alertas de estoque</h2>
        <StockAlerts />
      </section>
    </main>
  )
}
