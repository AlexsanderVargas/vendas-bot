import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'
import { CartProvider } from '@/lib/cart/cart-context'
import { ThemeStyle } from '@/components/branding/theme-style'
import { getBranding } from '@/lib/branding'

interface LayoutProps {
  children: ReactNode
  params: Promise<{ slug: string }>
}

/**
 * Metadados por estabelecimento: aba, ícone e o cartão que aparece quando o
 * link é compartilhado no WhatsApp. Sem isso, todo cardápio compartilhado
 * mostraria a marca do SaaS em vez da do restaurante.
 */
export async function generateMetadata({ params }: LayoutProps): Promise<Metadata> {
  const { slug } = await params
  const branding = await getBranding(slug)
  if (!branding) return { title: 'Estabelecimento não encontrado' }

  const description = branding.tagline ?? `Peça online no ${branding.displayName}.`

  return {
    title: { default: branding.displayName, template: `%s · ${branding.displayName}` },
    description,
    ...(branding.faviconUrl ? { icons: { icon: branding.faviconUrl } } : {}),
    openGraph: {
      title: branding.displayName,
      description,
      type: 'website',
      ...(branding.socialImageUrl ? { images: [branding.socialImageUrl] } : {}),
    },
    twitter: {
      card: branding.socialImageUrl ? 'summary_large_image' : 'summary',
      title: branding.displayName,
      description,
      ...(branding.socialImageUrl ? { images: [branding.socialImageUrl] } : {}),
    },
  }
}

/** O carrinho e a identidade visual são compartilhados por todas as telas. */
export default async function TenantLayout({ children, params }: LayoutProps) {
  const { slug } = await params
  const branding = await getBranding(slug)

  if (!branding) notFound()

  return (
    <>
      <ThemeStyle branding={branding} />
      <CartProvider tenantSlug={slug}>{children}</CartProvider>
    </>
  )
}
