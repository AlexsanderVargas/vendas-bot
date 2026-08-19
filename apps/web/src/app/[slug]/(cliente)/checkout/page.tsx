import { notFound, redirect } from 'next/navigation'
import { getMenuTenant } from '@vendas-bot/shared'
import { createClient } from '@/lib/supabase/server'
import { CheckoutForm } from '@/components/checkout/checkout-form'

export default async function CheckoutPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const supabase = await createClient()

  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) {
    redirect(`/${slug}/login?next=${encodeURIComponent(`/${slug}/checkout`)}`)
  }

  // Só o estabelecimento: o checkout não usa o cardápio, e carregá-lo custava
  // quatro consultas e a serialização de todos os produtos.
  const tenant = await getMenuTenant(supabase, slug)
  if (!tenant) notFound()

  return (
    <main className="mx-auto max-w-2xl px-4 pb-24">
      <h1 className="pt-8 text-2xl font-bold tracking-tight">Finalizar pedido</h1>
      <CheckoutForm tenant={tenant} />
    </main>
  )
}
