'use server'

import { redirect } from 'next/navigation'
import { normalizeToE164 } from '@vendas-bot/shared'
import { createClient } from '@/lib/supabase/server'

export interface CompleteProfileState {
  readonly error: string | null
}

/**
 * Contrato: (prevState, formData) -> Promise<CompleteProfileState>
 * Cadastro progressivo: cria (ou completa) o vínculo do cliente com o tenant
 * gravando apenas o WhatsApp. A RLS garante que auth_user_id seja o próprio
 * usuário — a política customers_self_insert exige isso.
 */
export async function completeProfile(
  _prevState: CompleteProfileState,
  formData: FormData,
): Promise<CompleteProfileState> {
  const tenantSlug = String(formData.get('tenant') ?? '')
  const next = String(formData.get('next') ?? '/')
  const rawPhone = String(formData.get('whatsapp') ?? '')
  const name = String(formData.get('name') ?? '').trim()

  const whatsapp = normalizeToE164(rawPhone)
  if (!whatsapp) {
    return { error: 'Informe um WhatsApp válido com DDD, ex.: (51) 99999-0001.' }
  }

  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) return { error: 'Sessão expirada. Entre novamente.' }

  const { data: tenant } = await supabase
    .from('tenants')
    .select('id')
    .eq('slug', tenantSlug)
    .maybeSingle()
  if (!tenant) return { error: 'Estabelecimento não encontrado.' }

  const { error } = await supabase
    .from('customers')
    .upsert(
      {
        tenant_id: tenant.id,
        auth_user_id: auth.user.id,
        name: name || (auth.user.user_metadata.full_name as string | undefined) || null,
        whatsapp,
      },
      { onConflict: 'tenant_id,auth_user_id' },
    )

  if (error) return { error: `Não foi possível salvar seu cadastro: ${error.message}` }

  redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/')
}
