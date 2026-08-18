import Image from 'next/image'
import type { Branding, MenuTenant } from '@vendas-bot/shared'
import { SOCIAL_LABEL, socialEntries } from '@vendas-bot/shared'

const FEE_MODE_LABEL: Record<MenuTenant['deliveryFeeMode'], string> = {
  distance: 'Taxa de entrega por distância',
  neighborhood: 'Taxa de entrega por bairro',
  fixed: 'Taxa de entrega fixa',
}

/**
 * Cabeçalho do cardápio com a marca do estabelecimento.
 *
 * Substitui o cabeçalho de texto puro: quando o lojista enviou capa e logo, o
 * cliente final vê a marca dele, não a do SaaS. Sem capa nem logo, cai para
 * o nome — nenhum espaço vazio ou imagem quebrada.
 */
export function BrandedHeader({
  tenant,
  branding,
}: {
  tenant: MenuTenant
  branding: Branding
}) {
  const { street, number, neighborhood, city, state } = tenant.address
  const address = [
    street && `${street}${number ? `, ${number}` : ''}`,
    neighborhood,
    city && state ? `${city}/${state}` : city,
  ]
    .filter(Boolean)
    .join(' · ')

  const socials = socialEntries(branding.socialLinks)

  return (
    <header className="flex flex-col">
      {branding.bannerMessage ? (
        <p
          className="-mx-4 px-4 py-2 text-center text-sm font-medium"
          style={{
            background: 'var(--brand-primary)',
            color: 'var(--brand-primary-contrast)',
          }}
        >
          {branding.bannerMessage}
        </p>
      ) : null}

      {branding.coverUrl ? (
        <div className="relative -mx-4 aspect-[3/1] overflow-hidden sm:rounded-b-2xl">
          <Image
            src={branding.coverUrl}
            alt=""
            fill
            unoptimized
            priority
            sizes="(max-width: 768px) 100vw, 768px"
            className="object-cover"
          />
        </div>
      ) : null}

      <div className="flex items-start gap-4 border-b border-border py-6">
        {branding.logoUrl ? (
          <div
            className="relative h-20 w-20 shrink-0 overflow-hidden border border-border bg-background"
            style={{ borderRadius: 'var(--brand-radius)' }}
          >
            <Image
              src={branding.logoUrl}
              alt={`Logo ${branding.displayName}`}
              fill
              unoptimized
              priority
              sizes="80px"
              className="object-contain"
            />
          </div>
        ) : null}

        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-bold tracking-tight">{branding.displayName}</h1>
          {branding.tagline ? (
            <p className="text-sm font-medium" style={{ color: 'var(--brand-primary)' }}>
              {branding.tagline}
            </p>
          ) : null}
          {address ? <p className="text-sm text-muted-foreground">{address}</p> : null}
          <p className="text-sm text-muted-foreground">
            {FEE_MODE_LABEL[tenant.deliveryFeeMode]}
          </p>

          {socials.length > 0 ? (
            <ul className="mt-1 flex flex-wrap gap-3 text-sm">
              {socials.map((entry) => (
                <li key={entry.network}>
                  <a
                    href={entry.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="underline underline-offset-4"
                    style={{ color: 'var(--brand-primary)' }}
                  >
                    {SOCIAL_LABEL[entry.network]}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      {branding.about ? (
        <p className="border-b border-border py-4 text-sm text-muted-foreground">
          {branding.about}
        </p>
      ) : null}
    </header>
  )
}
