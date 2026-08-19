import { createClient } from '@/lib/supabase/server'
import { FiscalManager } from '@/components/painel/fiscal-manager'

export default async function FiscalPage() {
  const supabase = await createClient()
  const { data: products } = await supabase
    .from('products')
    .select('id, name')
    .eq('is_active', true)
    .order('name')

  return (
    <main>
      <h1 className="mb-2 text-2xl font-bold tracking-tight">Fiscal</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Configuração tributária e acompanhamento dos documentos. A emissão depende de certificado
        digital e credenciamento na SEFAZ.
      </p>
      <FiscalManager products={products ?? []} />
    </main>
  )
}
