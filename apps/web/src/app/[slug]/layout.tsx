import type { ReactNode } from 'react'
import { CartProvider } from '@/lib/cart/cart-context'

/** O carrinho é compartilhado por todas as telas do estabelecimento. */
export default async function TenantLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  return <CartProvider tenantSlug={slug}>{children}</CartProvider>
}
