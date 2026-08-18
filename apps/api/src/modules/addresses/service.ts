import type { SupabaseClient } from '@supabase/supabase-js'
import { parseLocation } from '@vendas-bot/shared'
import type { Address, DeliveryQuote } from './schemas.js'

interface AddressRow {
  id: string
  label: string
  street: string
  number: string
  complement: string | null
  neighborhood: string
  city: string
  state: string
  zip_code: string | null
  reference: string | null
  location: unknown
  is_default: boolean
}

const ADDRESS_COLUMNS =
  'id, label, street, number, complement, neighborhood, city, state, zip_code, reference, location, is_default'

/** Contrato: (row) -> Address — normaliza a linha do banco no formato de saída. */
export function toAddress(row: AddressRow): Address {
  const point = parseLocation(row.location)
  return {
    id: row.id,
    label: row.label,
    street: row.street,
    number: row.number,
    complement: row.complement,
    neighborhood: row.neighborhood,
    city: row.city,
    state: row.state,
    zipCode: row.zip_code,
    reference: row.reference,
    latitude: point?.latitude ?? null,
    longitude: point?.longitude ?? null,
    isDefault: row.is_default,
  }
}

/** Contrato: (supabase, customerId) -> Promise<Address[]> — padrão primeiro. */
export async function listAddresses(
  supabase: SupabaseClient,
  customerId: string,
): Promise<Address[]> {
  const { data, error } = await supabase
    .from('customer_addresses')
    .select(ADDRESS_COLUMNS)
    .eq('customer_id', customerId)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: true })

  if (error) throw new Error(error.message)
  return ((data ?? []) as AddressRow[]).map(toAddress)
}

/**
 * Contrato: (supabase, customerId, addressId) -> Promise<void>
 * Marca um endereço como padrão. O índice único parcial
 * customer_addresses_one_default exige zerar os demais antes.
 */
export async function setDefaultAddress(
  supabase: SupabaseClient,
  customerId: string,
  addressId: string,
): Promise<void> {
  const { error: clearError } = await supabase
    .from('customer_addresses')
    .update({ is_default: false })
    .eq('customer_id', customerId)
    .eq('is_default', true)
  if (clearError) throw new Error(clearError.message)

  const { error } = await supabase
    .from('customer_addresses')
    .update({ is_default: true })
    .eq('customer_id', customerId)
    .eq('id', addressId)
  if (error) throw new Error(error.message)
}

interface QuoteRow {
  eligible: boolean
  fee: number | string
  mode: 'distance' | 'neighborhood' | 'fixed' | null
  distance_meters: number | string | null
  eta_minutes: number | null
  min_order: number | string
  reason: string | null
}

/**
 * Contrato: (supabase, params) -> Promise<DeliveryQuote>
 * Delega o cálculo à função SQL public.quote_delivery — a regra de negócio
 * mora no banco, então o mesmo resultado vale para API, painel e checkout.
 */
export async function quoteDelivery(
  supabase: SupabaseClient,
  params: {
    tenantId: string
    subtotal: number
    latitude?: number | null
    longitude?: number | null
    neighborhood?: string | null
    city?: string | null
  },
): Promise<DeliveryQuote> {
  const { data, error } = await supabase.rpc('quote_delivery', {
    p_tenant_id: params.tenantId,
    p_subtotal: params.subtotal,
    p_latitude: params.latitude ?? null,
    p_longitude: params.longitude ?? null,
    p_neighborhood: params.neighborhood ?? null,
    p_city: params.city ?? null,
  })

  if (error) throw new Error(error.message)

  const row = data as QuoteRow
  return {
    eligible: row.eligible,
    fee: Number(row.fee),
    mode: row.mode,
    distanceMeters: row.distance_meters === null ? null : Number(row.distance_meters),
    etaMinutes: row.eta_minutes,
    minOrder: Number(row.min_order),
    reason: row.reason,
  }
}
