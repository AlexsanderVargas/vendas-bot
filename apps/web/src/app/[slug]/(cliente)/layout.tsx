import type { ReactNode } from 'react'
import { CartProvider } from '@/lib/cart/cart-context'

/**
 * Telas do cliente: cardápio, carrinho, checkout, endereços e pedidos.
 * O agrupamento não aparece na URL — serve para que só este ramo carregue o
 * carrinho, que o painel da equipe não usa.
 */
export default async function ClienteLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  return <CartProvider tenantSlug={slug}>{children}</CartProvider>
}
