import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Contrato: (supabase, slug) -> Promise<{ tenantId, customerId } | null>
 * Resolve o vínculo do cliente autenticado com um estabelecimento.
 * Null quando o slug não existe ou o cliente ainda não completou o cadastro
 * progressivo naquele tenant.
 */
export async function resolveCustomerContext(
  supabase: SupabaseClient,
  slug: string,
  authUserId: string,
): Promise<{ tenantId: string; customerId: string } | null> {
  const { data: tenant } = await supabase
    .from('tenants')
    .select('id')
    .eq('slug', slug)
    .eq('is_active', true)
    .maybeSingle()
  if (!tenant) return null

  const { data: customer } = await supabase
    .from('customers')
    .select('id')
    .eq('tenant_id', tenant.id)
    .eq('auth_user_id', authUserId)
    .maybeSingle()
  if (!customer) return null

  return { tenantId: tenant.id, customerId: customer.id }
}

/**
 * Contrato: (latitude, longitude) -> string | null
 * Converte coordenadas em EWKT aceito pela coluna geography(Point,4326).
 */
export function toEwktPoint(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): string | null {
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return null
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null
  return `SRID=4326;POINT(${longitude} ${latitude})`
}
