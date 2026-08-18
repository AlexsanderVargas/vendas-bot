'use client'

import Image from 'next/image'
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '@/lib/api'
import {
  ALLOWED_MIME_TYPES,
  formatBytes,
  uploadMedia,
  type Media,
  type MediaKind,
} from '@/lib/media'
import { Button } from '@/components/ui/button'

const KIND_LABEL: Record<MediaKind, string> = {
  logo: 'Logo',
  logo_dark: 'Logo (tema escuro)',
  favicon: 'Ícone da aba',
  cover: 'Capa do cardápio',
  social: 'Imagem de compartilhamento',
  product: 'Foto de produto',
  category: 'Imagem de categoria',
  banner: 'Destaque',
  other: 'Outros',
}

const UPLOAD_KINDS: MediaKind[] = [
  'logo',
  'logo_dark',
  'favicon',
  'cover',
  'social',
  'product',
  'category',
  'banner',
  'other',
]

interface UnusedMedia {
  id: string
  publicUrl: string
  sizeBytes: number
}

export function MediaLibrary() {
  const [items, setItems] = useState<Media[]>([])
  const [unused, setUnused] = useState<{ items: UnusedMedia[]; totalBytes: number }>({
    items: [],
    totalBytes: 0,
  })
  const [kind, setKind] = useState<MediaKind>('product')
  const [filter, setFilter] = useState<MediaKind | ''>('')
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    const query = filter ? `?kind=${filter}` : ''
    const [library, orphans] = await Promise.all([
      apiFetch<{ items: Media[] }>(`/media${query}`),
      apiFetch<{ items: UnusedMedia[]; totalBytes: number }>('/media/unused'),
    ])
    setItems(library.items)
    setUnused(orphans)
  }, [filter])

  useEffect(() => {
    void load().catch((error: Error) => setStatus(error.message))
  }, [load])

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    setBusy(true)
    setStatus(null)

    // Um a um, e não em paralelo: assim uma imagem recusada não derruba as
    // outras, e o dono vê exatamente qual falhou.
    const failures: string[] = []
    for (const file of Array.from(files)) {
      try {
        await uploadMedia(file, kind)
      } catch (error) {
        failures.push(`${file.name}: ${(error as Error).message}`)
      }
    }

    setBusy(false)
    if (inputRef.current) inputRef.current.value = ''
    setStatus(
      failures.length === 0
        ? `${files.length} imagem(ns) enviada(s).`
        : failures.join(' · '),
    )
    await load().catch(() => undefined)
  }

  async function remove(id: string) {
    setBusy(true)
    try {
      await apiFetch(`/media/${id}`, { method: 'DELETE' })
      await load()
      setStatus('Imagem removida.')
    } catch (error) {
      setStatus((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function saveAlt(id: string, altText: string) {
    try {
      await apiFetch(`/media/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ altText: altText || null }),
      })
      setStatus('Descrição salva.')
    } catch (error) {
      setStatus((error as Error).message)
    }
  }

  return (
    <section className="flex flex-col gap-6">
      <div className="rounded-xl border border-border p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Enviar como</span>
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as MediaKind)}
              className="h-9 rounded-lg border border-input bg-background px-2 text-sm"
            >
              {UPLOAD_KINDS.map((option) => (
                <option key={option} value={option}>
                  {KIND_LABEL[option]}
                </option>
              ))}
            </select>
          </label>

          <input
            ref={inputRef}
            type="file"
            multiple
            accept={ALLOWED_MIME_TYPES.join(',')}
            onChange={(event) => void handleFiles(event.target.files)}
            disabled={busy}
            className="text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-primary file:px-3 file:py-2 file:text-sm file:text-primary-foreground"
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          PNG, JPG, WEBP, AVIF ou GIF, até 5 MB. Enviar como Logo, Capa ou Ícone já aplica a
          imagem no cardápio.
        </p>
        {status ? <p className="mt-2 text-sm">{status}</p> : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setFilter('')}
          className={`rounded-full border px-3 py-1 text-xs ${filter === '' ? 'bg-foreground text-background' : 'border-border'}`}
        >
          Todas
        </button>
        {UPLOAD_KINDS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setFilter(option)}
            className={`rounded-full border px-3 py-1 text-xs ${filter === option ? 'bg-foreground text-background' : 'border-border'}`}
          >
            {KIND_LABEL[option]}
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhuma imagem enviada ainda.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((media) => (
            <li key={media.id} className="flex flex-col gap-2 rounded-xl border border-border p-2">
              <div className="relative aspect-square overflow-hidden rounded-lg bg-muted">
                <Image
                  src={media.publicUrl}
                  alt={media.altText ?? ''}
                  fill
                  unoptimized
                  sizes="200px"
                  className="object-cover"
                />
              </div>
              <span className="text-xs text-muted-foreground">
                {KIND_LABEL[media.kind]} · {formatBytes(media.sizeBytes)}
                {media.width && media.height ? ` · ${media.width}×${media.height}` : ''}
              </span>
              {/* Texto alternativo: o cardápio é público e precisa ser legível
                  por leitor de tela. */}
              <input
                defaultValue={media.altText ?? ''}
                onBlur={(event) => void saveAlt(media.id, event.target.value)}
                placeholder="Descreva a imagem"
                className="h-8 rounded-lg border border-input bg-background px-2 text-xs"
              />
              <Button
                type="button"
                variant="ghost"
                onClick={() => void remove(media.id)}
                disabled={busy}
                className="h-8 text-xs text-destructive"
              >
                Remover
              </Button>
            </li>
          ))}
        </ul>
      )}

      {unused.items.length > 0 ? (
        <div className="rounded-xl border border-dashed border-border p-4">
          <h2 className="text-sm font-semibold">
            {unused.items.length} imagem(ns) sem uso · {formatBytes(unused.totalBytes)}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Nenhum produto, categoria ou a identidade visual usa estas imagens.
          </p>
        </div>
      ) : null}
    </section>
  )
}
