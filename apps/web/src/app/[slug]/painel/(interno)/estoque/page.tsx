import { createClient } from '@/lib/supabase/server'
import { StockManager } from '@/components/painel/stock-manager'

export default async function EstoquePage() {
  const supabase = await createClient()
  const { data: suppliers } = await supabase
    .from('suppliers')
    .select('id, name')
    .eq('is_active', true)
    .order('name')

  return (
    <main>
      <h1 className="mb-6 text-2xl font-bold tracking-tight">Estoque</h1>
      <StockManager suppliers={suppliers ?? []} />
    </main>
  )
}
