import { describe, expect, it } from 'vitest'
import type { Branding } from '@vendas-bot/shared'
import {
  contrastRatio,
  fontStack,
  fontUrl,
  hexToRgb,
  readableTextOn,
  relativeLuminance,
  socialEntries,
  socialUrl,
  themeStyleSheet,
  themeVariables,
  withAlpha,
} from '@vendas-bot/shared'

const BRANDING: Branding = {
  tenantId: 'tenant-1',
  name: 'Lancheria T1',
  displayName: 'Lancheria do Zé',
  tagline: 'O melhor X-Salada da cidade',
  about: null,
  logoUrl: 'https://cdn/logo.png',
  logoDarkUrl: null,
  faviconUrl: null,
  coverUrl: 'https://cdn/capa.jpg',
  socialImageUrl: 'https://cdn/capa.jpg',
  primaryColor: '#2A7FE8',
  primaryContrast: '#FFFFFF',
  accentColor: '#FFC24B',
  backgroundColor: null,
  surfaceColor: null,
  textColor: null,
  fontFamily: 'poppins',
  themeMode: 'light',
  cornerRadius: 20,
  socialLinks: { instagram: '@lancheriadoze', whatsapp: '+55 51 99999-0001' },
  bannerMessage: null,
  isCustomized: true,
}

describe('hexToRgb', () => {
  it('converte hex de 6 dígitos', () => {
    expect(hexToRgb('#2A7FE8')).toEqual({ r: 42, g: 127, b: 232 })
  })
  it('expande hex de 3 dígitos', () => {
    expect(hexToRgb('#FFF')).toEqual({ r: 255, g: 255, b: 255 })
  })
  it('devolve null para valor inválido', () => {
    expect(hexToRgb('roxo')).toBeNull()
    expect(hexToRgb('#GG0000')).toBeNull()
  })
})

describe('contraste', () => {
  it('luminância do branco é 1 e do preto é 0', () => {
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 5)
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5)
  })
  it('branco sobre preto tem a razão máxima de 21', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBe(21)
  })
  it('mesma cor tem razão 1', () => {
    expect(contrastRatio('#2A7FE8', '#2A7FE8')).toBe(1)
  })
  it('sugere texto branco sobre fundo escuro', () => {
    expect(readableTextOn('#1A1A1A')).toBe('#FFFFFF')
  })
  it('sugere texto escuro sobre fundo claro', () => {
    expect(readableTextOn('#FFE9A8')).toBe('#111111')
  })
})

describe('fontes', () => {
  it('devolve a pilha da fonte escolhida', () => {
    expect(fontStack('poppins')).toContain('Poppins')
  })
  it('fonte desconhecida cai para a do sistema', () => {
    expect(fontStack('inexistente' as never)).toContain('system-ui')
  })
  it('fonte do sistema não precisa ser baixada', () => {
    expect(fontUrl('system')).toBeNull()
  })
  it('fonte web devolve a URL do Google Fonts', () => {
    expect(fontUrl('poppins')).toContain('family=Poppins')
  })
})

describe('withAlpha', () => {
  it('produz cor com transparência', () => {
    expect(withAlpha('#2A7FE8', 0.12)).toBe('rgb(42 127 232 / 0.12)')
  })
  it('limita o alfa ao intervalo válido', () => {
    expect(withAlpha('#000000', 5)).toContain('/ 1')
    expect(withAlpha('#000000', -1)).toContain('/ 0')
  })
  it('devolve a entrada quando a cor é inválida', () => {
    expect(withAlpha('roxo', 0.5)).toBe('roxo')
  })
})

describe('themeVariables', () => {
  it('deriva as variáveis da cor principal', () => {
    const variables = themeVariables(BRANDING)
    expect(variables['--brand-primary']).toBe('#2A7FE8')
    expect(variables['--brand-primary-soft']).toBe('rgb(42 127 232 / 0.12)')
    expect(variables['--brand-radius']).toBe('20px')
    expect(variables['--brand-font']).toContain('Poppins')
  })

  it('omite cores opcionais não definidas, preservando o padrão do produto', () => {
    const variables = themeVariables(BRANDING)
    expect(variables['--background']).toBeUndefined()
    expect(variables['--foreground']).toBeUndefined()
  })

  it('aplica as cores opcionais quando o lojista as define', () => {
    const variables = themeVariables({
      ...BRANDING,
      backgroundColor: '#0B0B0B',
      textColor: '#F5F5F5',
      surfaceColor: '#1A1A1A',
    })
    expect(variables['--background']).toBe('#0B0B0B')
    expect(variables['--foreground']).toBe('#F5F5F5')
    expect(variables['--muted']).toBe('#1A1A1A')
  })

  it('gera folha de estilo pronta para o servidor', () => {
    const css = themeStyleSheet(BRANDING)
    expect(css.startsWith(':root{')).toBe(true)
    expect(css).toContain('--brand-primary:#2A7FE8')
    expect(css.endsWith('}')).toBe(true)
  })
})

describe('socialUrl', () => {
  it('monta a URL a partir do arroba', () => {
    expect(socialUrl('instagram', '@lancheriadoze')).toBe('https://instagram.com/lancheriadoze')
  })
  it('aceita o identificador sem arroba', () => {
    expect(socialUrl('instagram', 'lancheriadoze')).toBe('https://instagram.com/lancheriadoze')
  })
  it('preserva a URL completa que o lojista colou', () => {
    expect(socialUrl('instagram', 'https://instagram.com/outro')).toBe('https://instagram.com/outro')
  })
  it('monta o link do WhatsApp só com os dígitos', () => {
    expect(socialUrl('whatsapp', '+55 (51) 99999-0001')).toBe('https://wa.me/5551999990001')
  })
  it('devolve null para valor vazio', () => {
    expect(socialUrl('instagram', '   ')).toBeNull()
  })
  it('WhatsApp sem dígito algum devolve null', () => {
    expect(socialUrl('whatsapp', 'meu-zap')).toBeNull()
  })
})

describe('socialEntries', () => {
  it('devolve apenas as redes preenchidas, na ordem canônica', () => {
    expect(socialEntries(BRANDING.socialLinks)).toEqual([
      { network: 'instagram', url: 'https://instagram.com/lancheriadoze' },
      { network: 'whatsapp', url: 'https://wa.me/5551999990001' },
    ])
  })
  it('ignora rede com valor inutilizável', () => {
    expect(socialEntries({ whatsapp: 'sem-numero' })).toEqual([])
  })
  it('devolve lista vazia quando nada foi preenchido', () => {
    expect(socialEntries({})).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Aplicação do tema (PBI 45): o que o servidor injeta no HTML.
// ---------------------------------------------------------------------------
describe('tema aplicado no servidor', () => {
  it('a folha de estilo é um bloco :root pronto para o <style>', () => {
    const css = themeStyleSheet(BRANDING)
    expect(css.startsWith(':root{')).toBe(true)
    expect(css.endsWith('}')).toBe(true)
  })

  it('a cor principal chega ao CSS exatamente como foi salva', () => {
    expect(themeStyleSheet(BRANDING)).toContain('--brand-primary:#2A7FE8')
  })

  it('o arredondamento vira pixels', () => {
    expect(themeVariables(BRANDING)['--brand-radius']).toBe('20px')
  })

  it('a fonte escolhida entra na variável usada pelo body', () => {
    expect(themeVariables(BRANDING)['--brand-font']).toContain('Poppins')
  })

  it('cor secundária ausente não sobrescreve o padrão do produto', () => {
    // Emitir "--background:null" pintaria o cardápio de nada.
    const variables = themeVariables({ ...BRANDING, backgroundColor: null, textColor: null })
    expect(variables['--background']).toBeUndefined()
    expect(variables['--foreground']).toBeUndefined()
  })

  it('cor secundária definida entra no CSS', () => {
    const variables = themeVariables({ ...BRANDING, backgroundColor: '#101010' })
    expect(variables['--background']).toBe('#101010')
  })

  it('o realce suave é derivado da cor principal, não fixo', () => {
    const azul = themeVariables(BRANDING)['--brand-primary-soft']
    const verde = themeVariables({ ...BRANDING, primaryColor: '#1A7F37' })['--brand-primary-soft']
    expect(azul).not.toBe(verde)
  })

  it('a folha de estilo não deixa escapar do <style>', () => {
    // As aspas que sobram são as do nome da fonte ("Poppins"), que é CSS
    // legítimo e vem de lista fechada. O que não pode aparecer é marcação.
    const css = themeStyleSheet(BRANDING)
    expect(css).not.toContain('<')
    expect(css).not.toContain('>')
  })

  it('fonte fora da lista não produz valor arbitrário no CSS', () => {
    const css = themeStyleSheet({ ...BRANDING, fontFamily: '</style><script>' as never })
    expect(css).not.toContain('script')
    expect(css).toContain('system-ui')
  })

  it('estabelecimento sem personalização gera CSS válido com os padrões', () => {
    const padrao = themeStyleSheet({
      ...BRANDING,
      isCustomized: false,
      primaryColor: '#E85D2A',
      fontFamily: 'system',
      cornerRadius: 12,
    })
    expect(padrao).toContain('--brand-primary:#E85D2A')
    expect(padrao).toContain('--brand-radius:12px')
  })
})
