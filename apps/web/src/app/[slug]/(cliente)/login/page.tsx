import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { SocialLoginButtons } from '@/app/login/social-login-buttons'
import { getBranding } from '@/lib/branding'

export const metadata = { title: 'Entrar' }

/**
 * Entrada do cliente no estabelecimento. Existe com slug próprio para que a
 * tela mostre a marca de quem ele está comprando — e para que o cadastro
 * nasça vinculado ao estabelecimento certo, já que cliente é por loja.
 *
 * Só SSO: o cliente não cria senha nenhuma aqui.
 */
export default async function ClienteLoginPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const branding = await getBranding(slug)
  if (!branding) notFound()

  return (
    <main className="mx-auto flex min-h-dvh max-w-md items-center px-6">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>{branding.displayName}</CardTitle>
          <CardDescription>
            Entre para acompanhar seus pedidos, salvar endereços e acumular pontos.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <Suspense fallback={<p className="text-sm text-muted-foreground">Carregando…</p>}>
            <SocialLoginButtons tenantSlug={slug} defaultNext={`/${slug}`} />
          </Suspense>
          <p className="text-center text-sm text-muted-foreground">
            É da equipe do estabelecimento?{' '}
            <Link href={`/${slug}/painel/entrar`} className="underline underline-offset-4">
              Entre pelo painel
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    </main>
  )
}
