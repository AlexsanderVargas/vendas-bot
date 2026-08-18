import type { SupabaseClient } from '@supabase/supabase-js'

export interface CustomerProfile {
  readonly id: string
  readonly tenantId: string
  readonly name: string | null
  readonly whatsapp: string | null
  readonly loyaltyPoints: number
}

/**
 * Contrato: (supabase, tenantSlug) -> Promise<CustomerProfile | null>
 * Carrega o cadastro do cliente autenticado dentro de um tenant.
 * Null quando o usuário ainda não tem vínculo com o estabelecimento —
 * é o gatilho do cadastro progressivo.
 */
export async function getCustomerProfile(
  supabase: SupabaseClient,
  tenantSlug: string,
): Promise<CustomerProfile | null> {
  const { data: user } = await supabase.auth.getUser()
  if (!user.user) return null

  const { data: tenant } = await supabase
    .from('tenants')
    .select('id')
    .eq('slug', tenantSlug)
    .maybeSingle()
  if (!tenant) return null

  const { data } = await supabase
    .from('customers')
    .select('id, tenant_id, name, whatsapp, loyalty_points')
    .eq('tenant_id', tenant.id)
    .eq('auth_user_id', user.user.id)
    .maybeSingle()

  if (!data) return null
  return {
    id: data.id,
    tenantId: data.tenant_id,
    name: data.name,
    whatsapp: data.whatsapp,
    loyaltyPoints: data.loyalty_points,
  }
}

/** Contrato: (profile) -> boolean — perfil completo exige WhatsApp confirmado. */
export function isProfileComplete(profile: CustomerProfile | null): boolean {
  return profile !== null && profile.whatsapp !== null
}
