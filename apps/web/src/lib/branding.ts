import { cache } from 'react'
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
 *
 * Envolto em React.cache porque a mesma identidade é pedida três vezes na
 * mesma requisição — generateMetadata, o layout do tenant e a página do
 * cardápio. Como resolve_branding é RPC (POST), o Next não deduplica sozinho:
 * sem isto, toda visita ao cardápio custa três chamadas idênticas ao banco.
 */
export const getBranding = cache(async function getBranding(
  slug: string,
): Promise<Branding | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('resolve_branding', { p_slug: slug })

  if (error || !data) return null
  return data as Branding
})
