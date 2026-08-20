import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { AddressManager } from '@/components/address/address-manager'

export default async function EnderecosPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const supabase = await createClient()
  const { data } = await supabase.auth.getUser()

  if (!data.user) {
    redirect(`/${slug}/login?next=${encodeURIComponent(`/${slug}/enderecos`)}`)
  }

  return (
    <main className="mx-auto max-w-2xl px-4">
      <h1 className="pt-8 text-2xl font-bold tracking-tight">Endereços de entrega</h1>
      <AddressManager tenantSlug={slug} />
    </main>
  )
}
