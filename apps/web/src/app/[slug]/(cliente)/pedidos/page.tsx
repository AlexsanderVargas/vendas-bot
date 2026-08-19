import Link from 'next/link'
import { redirect } from 'next/navigation'
import { formatBRL } from '@vendas-bot/shared'
import { createClient } from '@/lib/supabase/server'

const STATUS_LABEL: Record<string, string> = {
  draft: 'Rascunho', placed: 'Enviado', confirmed: 'Confirmado', preparing: 'Em preparo',
  ready: 'Pronto', out_for_delivery: 'A caminho', delivered: 'Entregue',
  completed: 'Finalizado', canceled: 'Cancelado',
}

export default async function HistoricoPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const supabase = await createClient()

  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) redirect(`/login?tenant=${slug}&next=${encodeURIComponent(`/${slug}/pedidos`)}`)

  const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', slug).maybeSingle()

  const { data: orders } = await supabase
    .from('orders')
    .select('id, order_number, status, total, created_at')
    .eq('tenant_id', tenant?.id ?? '')
    .order('created_at', { ascending: false })
    .limit(30)

  return (
    <main className="mx-auto max-w-2xl px-4 pb-24">
      <h1 className="pt-8 text-2xl font-bold tracking-tight">Meus pedidos</h1>
      {!orders || orders.length === 0 ? (
        <p className="py-12 text-center text-muted-foreground">
          Você ainda não fez pedidos aqui.{' '}
          <Link href={`/${slug}`} className="underline">
            Ver cardápio
          </Link>
          .
        </p>
      ) : (
        <ul className="flex flex-col gap-3 py-8">
          {orders.map((order) => (
            <li key={order.id}>
              <Link
                href={`/${slug}/pedidos/${order.id}`}
                className="flex items-center justify-between gap-4 rounded-xl border border-border p-4 hover:bg-muted"
              >
                <span>
                  <span className="font-medium">Pedido nº {order.order_number}</span>
                  <span className="block text-sm text-muted-foreground">
                    {new Date(order.created_at).toLocaleString('pt-BR')} ·{' '}
                    {STATUS_LABEL[order.status] ?? order.status}
                  </span>
                </span>
                <span className="font-semibold">{formatBRL(Number(order.total))}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
