import { randomUUID } from 'node:crypto'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import { ErrorResponse, StandardErrors, Uuid } from '@vendas-bot/shared'
import {
  ALLOWED_MIME_TYPES,
  MAX_MEDIA_BYTES,
  MEDIA_BUCKET,
  MEDIA_KINDS,
  buildStoragePath,
  pathBelongsToTenant,
  publicUrlFor,
  type AllowedMimeType,
  type MediaKind,
} from './service.js'

const MimeSchema = Type.Union(ALLOWED_MIME_TYPES.map((mime) => Type.Literal(mime)))
const KindSchema = Type.Union(MEDIA_KINDS.map((kind) => Type.Literal(kind)))

/** Contrato de saída de uma mídia da biblioteca. */
const Media = Type.Object({
  id: Uuid,
  storagePath: Type.String(),
  publicUrl: Type.String(),
  kind: KindSchema,
  mimeType: Type.String(),
  sizeBytes: Type.Integer(),
  width: Type.Union([Type.Integer(), Type.Null()]),
  height: Type.Union([Type.Integer(), Type.Null()]),
  altText: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
})

/** Contrato: (row) -> Media. */
export function toMedia(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    storagePath: String(row.storage_path),
    publicUrl: String(row.public_url),
    kind: row.kind as MediaKind,
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes),
    width: row.width === null || row.width === undefined ? null : Number(row.width),
    height: row.height === null || row.height === undefined ? null : Number(row.height),
    altText: (row.alt_text as string | null) ?? null,
    createdAt: String(row.created_at),
  }
}

const mediaRoutes: FastifyPluginAsyncTypebox = async (app) => {
  /**
   * O arquivo NÃO passa pela API: ela assina um envio para um caminho já
   * dentro da pasta do estabelecimento e o navegador sobe direto para o
   * storage. Proxiar 5 MB por requisição só adicionaria latência e memória,
   * e o isolamento continua garantido porque quem escolhe o caminho é aqui.
   */
  app.post(
    '/media/upload-url',
    {
      onRequest: app.requirePermission('media.write'),
      schema: {
        tags: ['mídias'],
        description: 'Assina o envio de uma imagem para a pasta do próprio estabelecimento.',
        body: Type.Object({
          fileName: Type.String({ minLength: 1, maxLength: 200 }),
          mimeType: MimeSchema,
          sizeBytes: Type.Integer({ minimum: 1, maximum: MAX_MEDIA_BYTES }),
          kind: Type.Optional(KindSchema),
        }),
        response: {
          200: Type.Object({
            bucket: Type.String(),
            storagePath: Type.String(),
            publicUrl: Type.String(),
            token: Type.String(),
          }),
          ...StandardErrors,
        },
      },
    },
    async (request) => {
      const tenantId = request.requireTenantId()
      const body = request.body as {
        fileName: string
        mimeType: AllowedMimeType
        sizeBytes: number
        kind?: MediaKind
      }

      const storagePath = buildStoragePath({
        tenantId,
        kind: body.kind ?? 'other',
        fileName: body.fileName,
        mimeType: body.mimeType,
        unique: randomUUID(),
      })

      const { data, error } = await request.supabase.storage
        .from(MEDIA_BUCKET)
        .createSignedUploadUrl(storagePath)

      if (error || !data) {
        throw app.httpErrors.badGateway(error?.message ?? 'Falha ao assinar o envio')
      }

      return {
        bucket: MEDIA_BUCKET,
        storagePath,
        publicUrl: publicUrlFor(app.config.supabaseUrl, MEDIA_BUCKET, storagePath),
        token: data.token,
      }
    },
  )

  /**
   * Confirma o envio. Só aqui a imagem entra na biblioteca — se o upload
   * falhar no meio, sobra um arquivo órfão no bucket, não um registro
   * quebrado que a tela mostraria como imagem inexistente.
   */
  app.post(
    '/media',
    {
      onRequest: app.requirePermission('media.write'),
      schema: {
        tags: ['mídias'],
        description: 'Registra na biblioteca uma imagem já enviada ao storage.',
        body: Type.Object({
          storagePath: Type.String({ minLength: 1, maxLength: 400 }),
          mimeType: MimeSchema,
          sizeBytes: Type.Integer({ minimum: 1, maximum: MAX_MEDIA_BYTES }),
          kind: Type.Optional(KindSchema),
          width: Type.Optional(Type.Integer({ minimum: 1 })),
          height: Type.Optional(Type.Integer({ minimum: 1 })),
          altText: Type.Optional(Type.String({ maxLength: 160 })),
          checksum: Type.Optional(Type.String({ maxLength: 128 })),
        }),
        response: { 201: Type.Object({ id: Uuid, publicUrl: Type.String() }), ...StandardErrors },
      },
    },
    async (request, reply) => {
      const tenantId = request.requireTenantId()
      const body = request.body as Record<string, unknown>
      const storagePath = String(body.storagePath)

      if (!pathBelongsToTenant(storagePath, tenantId)) {
        throw app.httpErrors.forbidden('Caminho fora da pasta do estabelecimento')
      }

      const publicUrl = publicUrlFor(app.config.supabaseUrl, MEDIA_BUCKET, storagePath)

      // register_media é SECURITY DEFINER (grava também na identidade visual
      // quando o tipo é logo/capa/favicon), por isso vai pelo service_role.
      const { data, error } = await app.supabaseAdmin.rpc('register_media', {
        p_tenant_id: tenantId,
        p_storage_path: storagePath,
        p_public_url: publicUrl,
        p_mime_type: body.mimeType,
        p_size_bytes: body.sizeBytes,
        p_kind: body.kind ?? 'other',
        p_width: body.width ?? null,
        p_height: body.height ?? null,
        p_alt_text: body.altText ?? null,
        p_checksum: body.checksum ?? null,
        p_uploaded_by: request.auth?.userId ?? null,
      })

      if (error) throw app.httpErrors.badRequest(error.message)

      return reply.code(201).send({ id: String(data), publicUrl })
    },
  )

  app.get(
    '/media',
    {
      onRequest: app.requireStaff,
      schema: {
        tags: ['mídias'],
        description: 'Biblioteca de imagens do estabelecimento.',
        querystring: Type.Object({
          kind: Type.Optional(KindSchema),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 60 })),
        }),
        response: { 200: Type.Object({ items: Type.Array(Media) }), ...StandardErrors },
      },
    },
    async (request) => {
      const query = request.query as { kind?: MediaKind; limit?: number }

      let builder = request.supabase
        .from('tenant_media')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(query.limit ?? 60)

      if (query.kind) builder = builder.eq('kind', query.kind)

      const { data, error } = await builder
      if (error) throw app.httpErrors.internalServerError(error.message)

      return { items: (data ?? []).map((row) => toMedia(row as Record<string, unknown>)) }
    },
  )

  /** Imagens que nenhum produto, categoria ou a identidade visual usa. */
  app.get(
    '/media/unused',
    {
      onRequest: app.requirePermission('media.write'),
      schema: {
        tags: ['mídias'],
        description: 'Imagens sem uso — candidatas a remoção.',
        response: {
          200: Type.Object({
            items: Type.Array(
              Type.Object({
                id: Uuid,
                storagePath: Type.String(),
                publicUrl: Type.String(),
                kind: KindSchema,
                sizeBytes: Type.Integer(),
                createdAt: Type.String(),
              }),
            ),
            totalBytes: Type.Integer(),
          }),
          ...StandardErrors,
        },
      },
    },
    async (request) => {
      const tenantId = request.requireTenantId()

      const { data, error } = await request.supabase.rpc('unused_media', {
        p_tenant_id: tenantId,
      })
      if (error) throw app.httpErrors.internalServerError(error.message)

      const items = ((data ?? []) as Record<string, unknown>[]).map((row) => ({
        id: String(row.id),
        storagePath: String(row.storage_path),
        publicUrl: String(row.public_url),
        kind: row.kind as MediaKind,
        sizeBytes: Number(row.size_bytes),
        createdAt: String(row.created_at),
      }))

      return { items, totalBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0) }
    },
  )

  app.patch(
    '/media/:id',
    {
      onRequest: app.requirePermission('media.write'),
      schema: {
        tags: ['mídias'],
        description: 'Atualiza o texto alternativo ou a finalidade da imagem.',
        params: Type.Object({ id: Uuid }),
        body: Type.Object({
          altText: Type.Optional(Type.Union([Type.String({ maxLength: 160 }), Type.Null()])),
          kind: Type.Optional(KindSchema),
        }),
        response: { 200: Type.Object({ updated: Type.Boolean() }), ...StandardErrors },
      },
    },
    async (request) => {
      const params = request.params as { id: string }
      const body = request.body as { altText?: string | null; kind?: MediaKind }

      const patch: Record<string, unknown> = {}
      if (body.altText !== undefined) patch.alt_text = body.altText
      if (body.kind !== undefined) patch.kind = body.kind

      const { data, error } = await request.supabase
        .from('tenant_media')
        .update(patch)
        .eq('id', params.id)
        .select('id')

      if (error) throw app.httpErrors.badRequest(error.message)
      // RLS filtra a linha de outro estabelecimento: o update não falha,
      // simplesmente não atinge ninguém. 404 é a resposta honesta.
      if (!data || data.length === 0) throw app.httpErrors.notFound('Imagem não encontrada')

      return { updated: true }
    },
  )

  /**
   * Remoção apaga o arquivo E o registro. A ordem importa: se o registro
   * sumisse primeiro e o storage falhasse, o arquivo ficaria pago e invisível.
   */
  app.delete(
    '/media/:id',
    {
      onRequest: app.requirePermission('media.write'),
      schema: {
        tags: ['mídias'],
        description: 'Remove a imagem do storage e da biblioteca.',
        params: Type.Object({ id: Uuid }),
        response: { 204: Type.Null(), ...StandardErrors },
      },
    },
    async (request, reply) => {
      const params = request.params as { id: string }

      const { data: found, error: findError } = await request.supabase
        .from('tenant_media')
        .select('id, storage_path')
        .eq('id', params.id)
        .maybeSingle()

      if (findError) throw app.httpErrors.internalServerError(findError.message)
      if (!found) throw app.httpErrors.notFound('Imagem não encontrada')

      const { error: storageError } = await request.supabase.storage
        .from(MEDIA_BUCKET)
        .remove([String((found as Record<string, unknown>).storage_path)])

      if (storageError) throw app.httpErrors.badGateway(storageError.message)

      const { error } = await request.supabase.from('tenant_media').delete().eq('id', params.id)
      if (error) throw app.httpErrors.badRequest(error.message)

      return reply.code(204).send(null)
    },
  )

  /** Galeria do produto: a foto principal continua em products.image_url. */
  app.put(
    '/products/:id/media',
    {
      onRequest: app.requirePermission('products.write'),
      schema: {
        tags: ['mídias'],
        description: 'Define a galeria do produto, na ordem informada.',
        params: Type.Object({ id: Uuid }),
        body: Type.Object({ mediaIds: Type.Array(Uuid, { maxItems: 12 }) }),
        response: { 200: Type.Object({ count: Type.Integer() }), ...StandardErrors },
      },
    },
    async (request) => {
      const params = request.params as { id: string }
      const body = request.body as { mediaIds: string[] }
      const tenantId = request.requireTenantId()

      const { error: clearError } = await request.supabase
        .from('product_media')
        .delete()
        .eq('product_id', params.id)
      if (clearError) throw app.httpErrors.badRequest(clearError.message)

      if (body.mediaIds.length === 0) return { count: 0 }

      const rows = body.mediaIds.map((mediaId, index) => ({
        tenant_id: tenantId,
        product_id: params.id,
        media_id: mediaId,
        position: index,
      }))

      // O trigger do banco recusa mídia de outro estabelecimento — a
      // mensagem dele é mais precisa do que qualquer checagem daqui.
      const { error } = await request.supabase.from('product_media').insert(rows)
      if (error) throw app.httpErrors.badRequest(error.message)

      return { count: rows.length }
    },
  )
}

export default mediaRoutes
