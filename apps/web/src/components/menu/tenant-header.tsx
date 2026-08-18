import type { MenuTenant } from '@vendas-bot/shared'

const FEE_MODE_LABEL: Record<MenuTenant['deliveryFeeMode'], string> = {
  distance: 'Taxa de entrega por distância',
  neighborhood: 'Taxa de entrega por bairro',
  fixed: 'Taxa de entrega fixa',
}

export function TenantHeader({ tenant }: { tenant: MenuTenant }) {
  const { street, number, neighborhood, city, state } = tenant.address
  const address = [street && `${street}${number ? `, ${number}` : ''}`, neighborhood, city && state ? `${city}/${state}` : city]
    .filter(Boolean)
    .join(' · ')

  return (
    <header className="flex flex-col gap-2 border-b border-border py-8">
      <h1 className="text-3xl font-bold tracking-tight">{tenant.name}</h1>
      {address ? <p className="text-sm text-muted-foreground">{address}</p> : null}
      <p className="text-sm text-muted-foreground">{FEE_MODE_LABEL[tenant.deliveryFeeMode]}</p>
    </header>
  )
}
