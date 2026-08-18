import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { OrderTracker } from '@/components/orders/order-tracker'
import { ReviewPrompt } from '@/components/orders/review-prompt'
import { PaymentPanel } from '@/components/orders/payment-panel'

export default async function PedidoPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>
}) {
  const { slug, id } = await params
  const supabase = await createClient()

  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) redirect(`/login?tenant=${slug}&next=${encodeURIComponent(`/${slug}/pedidos/${id}`)}`)

  // A RLS já restringe ao próprio cliente: um pedido alheio simplesmente não vem.
  const { data: order } = await supabase
    .from('orders')
    .select('id, order_number, status, channel, subtotal, delivery_fee, total, payment_status')
    .eq('id', id)
    .maybeSingle()

  if (!order) notFound()

  const { data: items } = await supabase
    .from('order_items')
    .select('id, product_name, quantity, total')
    .eq('order_id', id)

  // Avaliação só faz sentido depois da conclusão e uma única vez por pedido.
  const concluido = order.status === 'delivered' || order.status === 'completed'
  const { data: avaliacao } = concluido
    ? await supabase.from('order_reviews').select('id').eq('order_id', id).maybeSingle()
    : { data: null }

  return (
    <main className="mx-auto max-w-2xl px-4 pb-24">
      <OrderTracker
        order={{
          id: order.id,
          orderNumber: Number(order.order_number),
          status: order.status,
          channel: order.channel,
          subtotal: Number(order.subtotal),
          deliveryFee: Number(order.delivery_fee),
          total: Number(order.total),
          items: (items ?? []).map((item) => ({
            id: item.id,
            productName: item.product_name,
            quantity: Number(item.quantity),
            total: Number(item.total),
          })),
        }}
      />
      <PaymentPanel
        orderId={order.id}
        tenantSlug={slug}
        total={Number(order.total)}
        paymentStatus={order.payment_status}
      />
      {concluido && !avaliacao ? <ReviewPrompt orderId={id} /> : null}
    </main>
  )
}
