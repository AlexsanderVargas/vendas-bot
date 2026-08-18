import type { Branding } from '@vendas-bot/shared'
import { createClient } from '@/lib/supabase/server'

/**
 * Contrato: (slug) -> Promise<Branding | null>
 *
 * Busca a identidade visual NO SERVIDOR. É o que evita o cardápio aparecer
 * com a cor padrão e trocar depois — o "piscar" que denunciaria que a marca
 * é aplicada por JavaScript.
 *
 * Vai direto ao banco (resolve_branding é público) em vez de passar pela
 * API: é uma leitura só, no caminho crítico da primeira renderização.
 */
export async function getBranding(slug: string): Promise<Branding | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('resolve_branding', { p_slug: slug })

  if (error || !data) return null
  return data as Branding
}
