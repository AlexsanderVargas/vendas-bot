import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getCustomerProfile, isProfileComplete } from '@/lib/auth/profile'

/**
 * Callback do OAuth: troca o code por sessão e decide o destino.
 * Cliente sem cadastro completo no tenant vai para o cadastro progressivo,
 * que pede apenas o WhatsApp.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl
  const code = searchParams.get('code')
  const next = sanitizeNext(searchParams.get('next'))
  const tenant = searchParams.get('tenant')
  const oauthError = searchParams.get('error_description') ?? searchParams.get('error')

  // Devolver a falha para a porta do estabelecimento, e não para a genérica:
  // quem tentou entrar no cardápio de uma loja precisa voltar para ela.
  const loginPath = tenant ? `/${tenant}/login` : '/login'

  if (oauthError) {
    return NextResponse.redirect(`${origin}${loginPath}?erro=${encodeURIComponent(oauthError)}`)
  }
  if (!code) {
    return NextResponse.redirect(`${origin}${loginPath}?erro=codigo-ausente`)
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) {
    return NextResponse.redirect(`${origin}${loginPath}?erro=${encodeURIComponent(error.message)}`)
  }

  if (tenant) {
    const profile = await getCustomerProfile(supabase, tenant)
    if (!isProfileComplete(profile)) {
      const url = new URL('/completar-cadastro', origin)
      url.searchParams.set('tenant', tenant)
      url.searchParams.set('next', next)
      return NextResponse.redirect(url)
    }
  }

  return NextResponse.redirect(`${origin}${next}`)
}

/** Só aceita caminhos internos — evita open redirect via ?next=//site-externo. */
function sanitizeNext(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/'
  return value
}
