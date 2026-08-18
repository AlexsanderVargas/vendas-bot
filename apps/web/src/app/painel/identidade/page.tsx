import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getBranding } from '@/lib/branding'
import { BrandingEditor } from '@/components/painel/branding-editor'

export const metadata = { title: 'Identidade visual' }

export default async function IdentidadePage() {
  const supabase = await createClient()
  const { data } = await supabase.auth.getUser()
  const tenantId = (data.user?.app_metadata as { tenant_id?: string } | null)?.tenant_id
  if (!tenantId) redirect('/painel')

  const { data: tenant } = await supabase
    .from('tenants')
    .select('slug')
    .eq('id', tenantId)
    .maybeSingle()

  const branding = tenant ? await getBranding(String(tenant.slug)) : null

  if (!branding) {
    return (
      <main>
        <h1 className="mb-2 text-2xl font-bold tracking-tight">Identidade visual</h1>
        <p className="text-sm text-muted-foreground">
          Não foi possível carregar a identidade do estabelecimento.
        </p>
      </main>
    )
  }

  return (
    <main>
      <h1 className="mb-2 text-2xl font-bold tracking-tight">Identidade visual</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        O cardápio é a sua vitrine. Ajuste cores, fonte e imagens — a prévia ao lado mostra
        exatamente o que o cliente final vai ver.
      </p>
      <BrandingEditor initial={branding} />
    </main>
  )
}
