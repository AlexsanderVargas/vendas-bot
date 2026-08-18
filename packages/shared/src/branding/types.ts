/** Identidade visual de um estabelecimento, servida ao cardápio e ao painel. */
export interface Branding {
  tenantId: string
  name: string
  displayName: string
  tagline: string | null
  about: string | null
  logoUrl: string | null
  logoDarkUrl: string | null
  faviconUrl: string | null
  coverUrl: string | null
  socialImageUrl: string | null
  primaryColor: string
  primaryContrast: string
  accentColor: string | null
  backgroundColor: string | null
  surfaceColor: string | null
  textColor: string | null
  fontFamily: FontKey
  themeMode: 'light' | 'dark' | 'system'
  cornerRadius: number
  socialLinks: Partial<Record<SocialNetwork, string>>
  bannerMessage: string | null
  /** Falso quando o estabelecimento ainda não personalizou nada. */
  isCustomized: boolean
}

export const SOCIAL_NETWORKS = [
  'instagram',
  'facebook',
  'whatsapp',
  'site',
  'tiktok',
  'youtube',
  'ifood',
] as const
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number]

export const FONT_KEYS = [
  'system',
  'inter',
  'roboto',
  'poppins',
  'montserrat',
  'lato',
  'open-sans',
  'nunito',
  'playfair',
  'oswald',
] as const
export type FontKey = (typeof FONT_KEYS)[number]

/** Rótulo de cada rede, para a interface não repetir esse mapa. */
export const SOCIAL_LABEL: Record<SocialNetwork, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  whatsapp: 'WhatsApp',
  site: 'Site',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  ifood: 'iFood',
}
