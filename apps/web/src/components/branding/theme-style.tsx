import type { Branding } from '@vendas-bot/shared'
import { fontUrl, themeStyleSheet } from '@vendas-bot/shared'

/**
 * Injeta a identidade visual como CSS no HTML do servidor.
 *
 * Renderizado dentro do layout, o <style> chega junto com a marcação — o
 * navegador nunca pinta a cor padrão primeiro. Por isso isto é um componente
 * de servidor e não um efeito no cliente.
 *
 * O conteúdo é seguro: cores passam pelo check is_hex_color do banco e a
 * fonte vem de uma lista fechada, então nada aqui é texto livre do lojista.
 */
export function ThemeStyle({ branding }: { branding: Branding }) {
  const font = fontUrl(branding.fontFamily)

  return (
    <>
      {font ? (
        <>
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
          <link rel="stylesheet" href={font} />
        </>
      ) : null}
      <style dangerouslySetInnerHTML={{ __html: themeStyleSheet(branding) }} />
    </>
  )
}
