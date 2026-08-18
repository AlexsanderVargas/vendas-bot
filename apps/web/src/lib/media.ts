import { apiFetch } from '@/lib/api'

export const MAX_MEDIA_BYTES = 5 * 1024 * 1024

export const ALLOWED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/avif',
  'image/gif',
] as const

export type MediaKind =
  | 'logo'
  | 'logo_dark'
  | 'favicon'
  | 'cover'
  | 'social'
  | 'product'
  | 'category'
  | 'banner'
  | 'other'

export interface Media {
  id: string
  storagePath: string
  publicUrl: string
  kind: MediaKind
  mimeType: string
  sizeBytes: number
  width: number | null
  height: number | null
  altText: string | null
  createdAt: string
}

interface SignedUpload {
  bucket: string
  storagePath: string
  publicUrl: string
  token: string
}

/** Contrato: (bytes) -> string — tamanho legível ("1,4 MB"). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(0)} KB`
  return `${(kb / 1024).toFixed(1).replace('.', ',')} MB`
}

/**
 * Contrato: (file) -> string | null — motivo da recusa, ou null se aceito.
 * Recusar aqui evita um envio de megabytes que o servidor rejeitaria no fim.
 */
export function validateFile(file: File): string | null {
  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) {
    return 'Formato não aceito. Use PNG, JPG, WEBP, AVIF ou GIF.'
  }
  if (file.size > MAX_MEDIA_BYTES) {
    return `Imagem muito grande (${formatBytes(file.size)}). O limite é ${formatBytes(MAX_MEDIA_BYTES)}.`
  }
  if (file.size === 0) return 'Arquivo vazio.'
  return null
}

/**
 * Contrato: (file) -> Promise<{width, height} | null>
 * Lê as dimensões no navegador. Null quando o arquivo não decodifica — o
 * envio segue mesmo assim, porque dimensão é informação auxiliar.
 */
export async function readDimensions(file: File): Promise<{ width: number; height: number } | null> {
  if (typeof createImageBitmap !== 'function') return null
  try {
    const bitmap = await createImageBitmap(file)
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return size
  } catch {
    return null
  }
}

/**
 * Contrato: (file, kind, altText?) -> Promise<Media>
 *
 * Três passos: a API assina um caminho dentro da pasta do estabelecimento, o
 * arquivo sobe direto para o storage (sem passar pela API) e só então o
 * registro é criado. Se o envio falhar no meio, sobra arquivo órfão no
 * bucket — nunca um registro apontando para imagem inexistente.
 */
export async function uploadMedia(
  file: File,
  kind: MediaKind,
  altText?: string,
): Promise<{ id: string; publicUrl: string }> {
  const problem = validateFile(file)
  if (problem) throw new Error(problem)

  const signed = await apiFetch<SignedUpload>('/media/upload-url', {
    method: 'POST',
    body: JSON.stringify({
      fileName: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      kind,
    }),
  })

  const { createClient } = await import('@/lib/supabase/client')
  const { error } = await createClient()
    .storage.from(signed.bucket)
    .uploadToSignedUrl(signed.storagePath, signed.token, file, {
      contentType: file.type,
    })

  if (error) throw new Error(`Falha ao enviar a imagem: ${error.message}`)

  const dimensions = await readDimensions(file)

  return apiFetch<{ id: string; publicUrl: string }>('/media', {
    method: 'POST',
    body: JSON.stringify({
      storagePath: signed.storagePath,
      mimeType: file.type,
      sizeBytes: file.size,
      kind,
      ...(dimensions ?? {}),
      ...(altText ? { altText } : {}),
    }),
  })
}
