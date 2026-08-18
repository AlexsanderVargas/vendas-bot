/**
 * Regras da biblioteca de mídias que valem tanto na API quanto nos testes.
 * O caminho do arquivo é o mecanismo de isolamento — as políticas de storage
 * derivam o estabelecimento dele —, então quem monta o caminho é aqui, uma
 * vez só, e não cada chamada de rota.
 */

export const MEDIA_BUCKET = 'tenant-media'

/** Mesmos tipos aceitos pela constraint do banco e pelo bucket. */
export const ALLOWED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/avif',
  'image/gif',
] as const

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number]

export const MAX_MEDIA_BYTES = 5 * 1024 * 1024

export const MEDIA_KINDS = [
  'logo',
  'logo_dark',
  'favicon',
  'cover',
  'social',
  'product',
  'category',
  'banner',
  'other',
] as const

export type MediaKind = (typeof MEDIA_KINDS)[number]

const EXTENSION_BY_MIME: Record<AllowedMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
}

/**
 * Contrato: (mime) -> string — extensão canônica do arquivo.
 * A extensão vem do tipo declarado, nunca do nome enviado pelo navegador:
 * "foto.png.html" não pode virar um .html servido do domínio do cliente.
 */
export function extensionFor(mime: AllowedMimeType): string {
  return EXTENSION_BY_MIME[mime]
}

/**
 * Contrato: (nome) -> string — nome reduzido a algo seguro para caminho.
 * Mantém uma pista do original (ajuda o dono a se achar na biblioteca) sem
 * deixar passar barra, ponto duplo ou acento.
 */
export function slugifyFileName(name: string): string {
  const withoutExtension = name.replace(/\.[^./\\]+$/, '')
  const slug = withoutExtension
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug || 'arquivo'
}

/** Contrato: (tenantId) -> string — prefixo obrigatório, espelha media_storage_prefix(). */
export function storagePrefix(tenantId: string): string {
  return `tenants/${tenantId}/`
}

export interface BuildPathInput {
  tenantId: string
  kind: MediaKind
  fileName: string
  mimeType: AllowedMimeType
  /** Sufixo único (uuid). Recebido de fora para o caminho ser testável. */
  unique: string
}

/**
 * Contrato: (BuildPathInput) -> string
 *   tenants/<tenantId>/<kind>/<slug>-<unique>.<ext>
 *
 * O sufixo único evita que dois envios com o mesmo nome se sobrescrevam —
 * substituir só acontece quando o cliente pede explicitamente, reenviando o
 * mesmo caminho.
 */
export function buildStoragePath(input: BuildPathInput): string {
  const slug = slugifyFileName(input.fileName)
  const ext = extensionFor(input.mimeType)
  return `${storagePrefix(input.tenantId)}${input.kind}/${slug}-${input.unique}.${ext}`
}

/**
 * Contrato: (path, tenantId) -> boolean
 *   Confere se o caminho pertence ao estabelecimento. A API valida antes de
 *   assinar o envio; o banco e o storage validam de novo. Redundância
 *   proposital: é o ponto onde um erro vazaria arquivo entre clientes.
 */
export function pathBelongsToTenant(path: string, tenantId: string): boolean {
  return path.startsWith(storagePrefix(tenantId)) && !path.includes('..')
}

/** Contrato: (supabaseUrl, bucket, path) -> string — URL pública do arquivo. */
export function publicUrlFor(supabaseUrl: string, bucket: string, path: string): string {
  const base = supabaseUrl.replace(/\/+$/, '')
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  return `${base}/storage/v1/object/public/${bucket}/${encoded}`
}
