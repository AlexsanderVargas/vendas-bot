'use client'

import Image from 'next/image'
import { useMemo, useState } from 'react'
import {
  FONT_KEYS,
  SOCIAL_LABEL,
  SOCIAL_NETWORKS,
  contrastRatio,
  fontStack,
  readableTextOn,
  themeVariables,
  type Branding,
  type FontKey,
  type SocialNetwork,
} from '@vendas-bot/shared'
import { apiFetch } from '@/lib/api'
import { uploadMedia, type MediaKind } from '@/lib/media'
import { Button } from '@/components/ui/button'

const FONT_LABEL: Record<FontKey, string> = {
  system: 'Padrão do sistema',
  inter: 'Inter',
  roboto: 'Roboto',
  poppins: 'Poppins',
  montserrat: 'Montserrat',
  lato: 'Lato',
  'open-sans': 'Open Sans',
  nunito: 'Nunito',
  playfair: 'Playfair Display',
  oswald: 'Oswald',
}

const IMAGE_FIELDS: { field: keyof Branding; kind: MediaKind; label: string; hint: string }[] = [
  { field: 'logoUrl', kind: 'logo', label: 'Logo', hint: 'Aparece no topo do cardápio.' },
  { field: 'logoDarkUrl', kind: 'logo_dark', label: 'Logo para tema escuro', hint: 'Opcional.' },
  { field: 'coverUrl', kind: 'cover', label: 'Capa', hint: 'Faixa larga acima do nome.' },
  { field: 'faviconUrl', kind: 'favicon', label: 'Ícone da aba', hint: 'Quadrado, 64×64 ou maior.' },
  {
    field: 'socialImageUrl',
    kind: 'social',
    label: 'Imagem de compartilhamento',
    hint: 'Cartão exibido ao mandar o link no WhatsApp.',
  },
]

/** Razão mínima da WCAG para texto normal. */
const MIN_CONTRAST = 4.5

export function BrandingEditor({ initial }: { initial: Branding }) {
  const [branding, setBranding] = useState<Branding>(initial)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function set<K extends keyof Branding>(field: K, value: Branding[K]) {
    setBranding((current) => ({ ...current, [field]: value }))
  }

  // A prévia usa exatamente as mesmas variáveis que o servidor injeta no
  // cardápio, então o que o lojista vê aqui é o que o cliente final verá.
  const previewStyle = useMemo(
    () => themeVariables(branding) as React.CSSProperties,
    [branding],
  )

  const contrast = contrastRatio(branding.primaryContrast, branding.primaryColor)
  const suggested = readableTextOn(branding.primaryColor)

  async function save() {
    setBusy(true)
    setStatus(null)
    try {
      await apiFetch('/branding', {
        method: 'PUT',
        body: JSON.stringify({
          displayName: branding.displayName,
          tagline: branding.tagline,
          about: branding.about,
          logoUrl: branding.logoUrl,
          logoDarkUrl: branding.logoDarkUrl,
          faviconUrl: branding.faviconUrl,
          coverUrl: branding.coverUrl,
          socialImageUrl: branding.socialImageUrl,
          primaryColor: branding.primaryColor,
          primaryContrast: branding.primaryContrast,
          accentColor: branding.accentColor,
          fontFamily: branding.fontFamily,
          themeMode: branding.themeMode,
          cornerRadius: branding.cornerRadius,
          socialLinks: branding.socialLinks,
          bannerMessage: branding.bannerMessage,
        }),
      })
      setStatus('Identidade visual salva. O cardápio já está com a sua marca.')
    } catch (error) {
      setStatus((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function upload(field: keyof Branding, kind: MediaKind, file: File | null) {
    if (!file) return
    setBusy(true)
    setStatus(null)
    try {
      const media = await uploadMedia(file, kind)
      // O envio já grava a imagem na identidade no banco; aqui o estado só
      // acompanha, para a prévia não ficar atrasada em relação ao salvo.
      set(field, media.publicUrl as Branding[typeof field])
      setStatus('Imagem enviada.')
    } catch (error) {
      setStatus((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
      <div className="flex flex-col gap-6">
        {/* ------------------------------------------------- identidade --- */}
        <section className="flex flex-col gap-3 rounded-xl border border-border p-4">
          <h2 className="text-sm font-semibold">Identidade</h2>

          <label className="flex flex-col gap-1 text-sm">
            <span>Nome exibido</span>
            <input
              value={branding.displayName}
              maxLength={80}
              onChange={(event) => set('displayName', event.target.value)}
              className="h-9 rounded-lg border border-input bg-background px-2"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span>Frase de efeito</span>
            <input
              value={branding.tagline ?? ''}
              maxLength={160}
              placeholder="O melhor X-Salada da cidade"
              onChange={(event) => set('tagline', event.target.value || null)}
              className="h-9 rounded-lg border border-input bg-background px-2"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span>Sobre o estabelecimento</span>
            <textarea
              value={branding.about ?? ''}
              maxLength={2000}
              rows={3}
              onChange={(event) => set('about', event.target.value || null)}
              className="rounded-lg border border-input bg-background p-2"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span>Aviso no topo do cardápio</span>
            <input
              value={branding.bannerMessage ?? ''}
              maxLength={200}
              placeholder="Fechado dia 25. Voltamos dia 26!"
              onChange={(event) => set('bannerMessage', event.target.value || null)}
              className="h-9 rounded-lg border border-input bg-background px-2"
            />
          </label>
        </section>

        {/* ----------------------------------------------------- cores --- */}
        <section className="flex flex-col gap-3 rounded-xl border border-border p-4">
          <h2 className="text-sm font-semibold">Cores e tipografia</h2>

          <div className="flex flex-wrap gap-4">
            <ColorField
              label="Cor principal"
              value={branding.primaryColor}
              onChange={(value) => set('primaryColor', value)}
            />
            <ColorField
              label="Cor do texto sobre ela"
              value={branding.primaryContrast}
              onChange={(value) => set('primaryContrast', value)}
            />
            <ColorField
              label="Cor de destaque"
              value={branding.accentColor ?? '#FFC24B'}
              onChange={(value) => set('accentColor', value)}
            />
          </div>

          {/* Contraste insuficiente deixa o botão ilegível para quem enxerga
              pouco — vale um aviso, não um bloqueio: a escolha é do lojista. */}
          {contrast < MIN_CONTRAST ? (
            <p className="rounded-lg bg-muted p-2 text-xs">
              Contraste de {contrast}:1 entre o texto e a cor principal — abaixo dos{' '}
              {MIN_CONTRAST}:1 recomendados. Com {suggested} o texto fica legível.{' '}
              <button
                type="button"
                onClick={() => set('primaryContrast', suggested)}
                className="underline underline-offset-2"
              >
                Usar {suggested}
              </button>
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Contraste de {contrast}:1 — legível.
            </p>
          )}

          <label className="flex flex-col gap-1 text-sm">
            <span>Fonte</span>
            <select
              value={branding.fontFamily}
              onChange={(event) => set('fontFamily', event.target.value as FontKey)}
              className="h-9 rounded-lg border border-input bg-background px-2"
            >
              {FONT_KEYS.map((font) => (
                <option key={font} value={font} style={{ fontFamily: fontStack(font) }}>
                  {FONT_LABEL[font]}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span>Arredondamento das bordas: {branding.cornerRadius}px</span>
            <input
              type="range"
              min={0}
              max={32}
              value={branding.cornerRadius}
              onChange={(event) => set('cornerRadius', Number(event.target.value))}
            />
          </label>
        </section>

        {/* --------------------------------------------------- imagens --- */}
        <section className="flex flex-col gap-4 rounded-xl border border-border p-4">
          <h2 className="text-sm font-semibold">Imagens</h2>
          {IMAGE_FIELDS.map((item) => {
            const url = branding[item.field] as string | null
            return (
              <div key={item.field} className="flex items-center gap-3">
                <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-border bg-muted">
                  {url ? (
                    <Image src={url} alt="" fill unoptimized sizes="56px" className="object-contain" />
                  ) : null}
                </div>
                <div className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">{item.label}</span>
                  <span className="text-xs text-muted-foreground">{item.hint}</span>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/avif,image/gif"
                    disabled={busy}
                    onChange={(event) =>
                      void upload(item.field, item.kind, event.target.files?.[0] ?? null)
                    }
                    className="text-xs"
                  />
                </div>
              </div>
            )
          })}
        </section>

        {/* ----------------------------------------------------- redes --- */}
        <section className="flex flex-col gap-3 rounded-xl border border-border p-4">
          <h2 className="text-sm font-semibold">Redes e contato</h2>
          <p className="text-xs text-muted-foreground">
            Pode informar o usuário (@perfil) ou o endereço completo.
          </p>
          {SOCIAL_NETWORKS.map((network: SocialNetwork) => (
            <label key={network} className="flex items-center gap-3 text-sm">
              <span className="w-24 shrink-0">{SOCIAL_LABEL[network]}</span>
              <input
                value={branding.socialLinks[network] ?? ''}
                maxLength={200}
                onChange={(event) => {
                  const links = { ...branding.socialLinks }
                  if (event.target.value) links[network] = event.target.value
                  else delete links[network]
                  set('socialLinks', links)
                }}
                className="h-9 flex-1 rounded-lg border border-input bg-background px-2"
              />
            </label>
          ))}
        </section>

        <div className="flex items-center gap-3">
          <Button type="button" onClick={() => void save()} disabled={busy}>
            Salvar identidade
          </Button>
          {status ? <span className="text-sm">{status}</span> : null}
        </div>
      </div>

      {/* ------------------------------------------------------ prévia --- */}
      <aside className="lg:sticky lg:top-6 lg:self-start">
        <h2 className="mb-2 text-sm font-semibold">Prévia do cardápio</h2>
        <div
          style={previewStyle}
          className="overflow-hidden rounded-xl border border-border"
        >
          {branding.bannerMessage ? (
            <p
              className="px-3 py-2 text-center text-xs font-medium"
              style={{ background: 'var(--brand-primary)', color: 'var(--brand-primary-contrast)' }}
            >
              {branding.bannerMessage}
            </p>
          ) : null}

          {branding.coverUrl ? (
            <div className="relative aspect-[3/1]">
              <Image src={branding.coverUrl} alt="" fill unoptimized sizes="320px" className="object-cover" />
            </div>
          ) : null}

          <div className="p-3" style={{ fontFamily: 'var(--brand-font)' }}>
            <div className="flex items-center gap-2">
              {branding.logoUrl ? (
                <div
                  className="relative h-10 w-10 overflow-hidden border border-border"
                  style={{ borderRadius: 'var(--brand-radius)' }}
                >
                  <Image src={branding.logoUrl} alt="" fill unoptimized sizes="40px" className="object-contain" />
                </div>
              ) : null}
              <div>
                <p className="text-sm font-bold">{branding.displayName}</p>
                {branding.tagline ? (
                  <p className="text-xs" style={{ color: 'var(--brand-primary)' }}>
                    {branding.tagline}
                  </p>
                ) : null}
              </div>
            </div>

            <div
              className="mt-3 flex items-center justify-between p-2 text-xs"
              style={{ background: 'var(--brand-primary-soft)', borderRadius: 'var(--brand-radius)' }}
            >
              <span>X-Salada</span>
              <span className="font-semibold">R$ 24,90</span>
            </div>

            <button
              type="button"
              className="mt-3 w-full py-2 text-sm font-medium"
              style={{
                background: 'var(--brand-primary)',
                color: 'var(--brand-primary-contrast)',
                borderRadius: 'var(--brand-radius)',
              }}
            >
              Adicionar ao carrinho
            </button>
          </div>
        </div>
      </aside>
    </div>
  )
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span>{label}</span>
      <span className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
          className="h-9 w-12 cursor-pointer rounded-lg border border-input bg-background"
        />
        <input
          value={value}
          maxLength={7}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
          className="h-9 w-24 rounded-lg border border-input bg-background px-2 font-mono text-xs"
        />
      </span>
    </label>
  )
}
