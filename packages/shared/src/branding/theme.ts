import type { Branding, FontKey, SocialNetwork } from './types.js'
import { SOCIAL_NETWORKS } from './types.js'

/**
 * Pilhas de fonte por chave. A lista é fechada de propósito: o valor vai
 * direto para o CSS servido ao cliente final, e aceitar texto livre abriria
 * espaço para injeção.
 */
const FONT_STACKS: Record<FontKey, string> = {
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  inter: '"Inter", system-ui, sans-serif',
  roboto: '"Roboto", system-ui, sans-serif',
  poppins: '"Poppins", system-ui, sans-serif',
  montserrat: '"Montserrat", system-ui, sans-serif',
  lato: '"Lato", system-ui, sans-serif',
  'open-sans': '"Open Sans", system-ui, sans-serif',
  nunito: '"Nunito", system-ui, sans-serif',
  playfair: '"Playfair Display", Georgia, serif',
  oswald: '"Oswald", system-ui, sans-serif',
}

/** Fontes que precisam ser carregadas do Google Fonts. */
const WEB_FONTS: Partial<Record<FontKey, string>> = {
  inter: 'Inter:wght@400;500;600;700',
  roboto: 'Roboto:wght@400;500;700',
  poppins: 'Poppins:wght@400;500;600;700',
  montserrat: 'Montserrat:wght@400;500;600;700',
  lato: 'Lato:wght@400;700',
  'open-sans': 'Open+Sans:wght@400;600;700',
  nunito: 'Nunito:wght@400;600;700',
  playfair: 'Playfair+Display:wght@400;600;700',
  oswald: 'Oswald:wght@400;500;600',
}

/** Contrato: (font) -> string — pilha de fontes CSS. */
export function fontStack(font: FontKey): string {
  return FONT_STACKS[font] ?? FONT_STACKS.system
}

/**
 * Contrato: (font) -> string | null
 * URL do Google Fonts, ou null quando a fonte é a do sistema (nada a baixar).
 */
export function fontUrl(font: FontKey): string | null {
  const spec = WEB_FONTS[font]
  return spec ? `https://fonts.googleapis.com/css2?family=${spec}&display=swap` : null
}

/** Contrato: (hex) -> { r, g, b } | null */
export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim())
  if (!match) return null

  let value = match[1]!
  if (value.length === 3) {
    value = value
      .split('')
      .map((char) => char + char)
      .join('')
  }

  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  }
}

/**
 * Contrato: (hex) -> number — luminância relativa (0 a 1) da WCAG.
 */
export function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex)
  if (!rgb) return 0

  const channel = (value: number) => {
    const normalized = value / 255
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4
  }

  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b)
}

/** Contrato: (foreground, background) -> number — razão de contraste da WCAG. */
export function contrastRatio(foreground: string, background: string): number {
  const light = Math.max(relativeLuminance(foreground), relativeLuminance(background))
  const dark = Math.min(relativeLuminance(foreground), relativeLuminance(background))
  return Number(((light + 0.05) / (dark + 0.05)).toFixed(2))
}

/**
 * Contrato: (background) -> '#FFFFFF' | '#111111'
 * Escolhe a cor de texto legível sobre um fundo. Usado para sugerir o
 * contraste no editor quando o lojista escolhe a cor principal.
 */
export function readableTextOn(background: string): string {
  return contrastRatio('#FFFFFF', background) >= contrastRatio('#111111', background)
    ? '#FFFFFF'
    : '#111111'
}

/**
 * Contrato: (hex, alpha) -> string — mesma cor com transparência, em rgb().
 * Usada para estados de foco e realce derivados da cor principal.
 */
export function withAlpha(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  const clamped = Math.min(Math.max(alpha, 0), 1)
  return `rgb(${rgb.r} ${rgb.g} ${rgb.b} / ${clamped})`
}

/**
 * Contrato: (branding) -> Record<string, string>
 * Variáveis CSS derivadas da identidade. São injetadas no servidor para o
 * cardápio nunca aparecer com a cor padrão antes de trocar (o "piscar" que
 * denunciaria que a marca é aplicada por JavaScript).
 */
export function themeVariables(branding: Branding): Record<string, string> {
  const variables: Record<string, string> = {
    '--brand-primary': branding.primaryColor,
    '--brand-primary-contrast': branding.primaryContrast,
    '--brand-primary-soft': withAlpha(branding.primaryColor, 0.12),
    '--brand-radius': `${branding.cornerRadius}px`,
    '--brand-font': fontStack(branding.fontFamily),
  }

  if (branding.accentColor) variables['--brand-accent'] = branding.accentColor
  if (branding.backgroundColor) variables['--background'] = branding.backgroundColor
  if (branding.surfaceColor) variables['--muted'] = branding.surfaceColor
  if (branding.textColor) variables['--foreground'] = branding.textColor

  return variables
}

/** Contrato: (branding) -> string — bloco CSS pronto para o <style> do servidor. */
export function themeStyleSheet(branding: Branding): string {
  const declarations = Object.entries(themeVariables(branding))
    .map(([name, value]) => `${name}:${value}`)
    .join(';')
  return `:root{${declarations}}`
}

/**
 * Contrato: (network, value) -> string | null
 * Monta a URL de cada rede a partir do que o lojista digitou: "@perfil",
 * "perfil" ou a URL completa, todos precisam funcionar.
 */
export function socialUrl(network: SocialNetwork, value: string): string | null {
  const raw = value.trim()
  if (!raw) return null
  if (/^https?:\/\//i.test(raw)) return raw

  const handle = raw.replace(/^@/, '')

  switch (network) {
    case 'instagram':
      return `https://instagram.com/${handle}`
    case 'facebook':
      return `https://facebook.com/${handle}`
    case 'tiktok':
      return `https://tiktok.com/@${handle}`
    case 'youtube':
      return `https://youtube.com/@${handle}`
    case 'whatsapp': {
      const digits = handle.replace(/\D/g, '')
      return digits ? `https://wa.me/${digits}` : null
    }
    case 'ifood':
      return `https://ifood.com.br/delivery/${handle}`
    case 'site':
      return `https://${handle}`
  }
}

/** Contrato: (links) -> Array<{ network, url }> — só as redes preenchidas. */
export function socialEntries(
  links: Partial<Record<SocialNetwork, string>>,
): Array<{ network: SocialNetwork; url: string }> {
  return SOCIAL_NETWORKS.flatMap((network) => {
    const value = links[network]
    if (!value) return []
    const url = socialUrl(network, value)
    return url ? [{ network, url }] : []
  })
}
