import { getBranding } from '@/lib/branding'
import { BrandingEditor } from '@/components/painel/branding-editor'

export const metadata = { title: 'Identidade visual' }

/**
 * O estabelecimento vem da URL. A guarda do painel já provou que quem está
 * aqui é funcionário ativo deste slug, então não há por que redescobrir o
 * vínculo pelo claim do JWT.
 */
export default async function IdentidadePage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const branding = await getBranding(slug)

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
