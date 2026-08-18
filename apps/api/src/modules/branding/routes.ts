import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import { ErrorResponse, Slug, StandardErrors, Uuid } from '@vendas-bot/shared'
import { FONT_KEYS, SOCIAL_NETWORKS } from '@vendas-bot/shared'

const HexColor = Type.String({ pattern: '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$' })
const FontSchema = Type.Union(FONT_KEYS.map((font) => Type.Literal(font)))
const ThemeModeSchema = Type.Union([
  Type.Literal('light'),
  Type.Literal('dark'),
  Type.Literal('system'),
])

const SocialLinks = Type.Object(
  Object.fromEntries(
    SOCIAL_NETWORKS.map((network) => [
      network,
      Type.Optional(Type.String({ maxLength: 200 })),
    ]),
  ),
  { additionalProperties: false },
)

/** Contrato de saída da identidade visual. Público: o cardápio depende dele. */
const Branding = Type.Object({
  tenantId: Uuid,
  name: Type.String(),
  displayName: Type.String(),
  tagline: Type.Union([Type.String(), Type.Null()]),
  about: Type.Union([Type.String(), Type.Null()]),
  logoUrl: Type.Union([Type.String(), Type.Null()]),
  logoDarkUrl: Type.Union([Type.String(), Type.Null()]),
  faviconUrl: Type.Union([Type.String(), Type.Null()]),
  coverUrl: Type.Union([Type.String(), Type.Null()]),
  socialImageUrl: Type.Union([Type.String(), Type.Null()]),
  primaryColor: HexColor,
  primaryContrast: HexColor,
  accentColor: Type.Union([HexColor, Type.Null()]),
  backgroundColor: Type.Union([HexColor, Type.Null()]),
  surfaceColor: Type.Union([HexColor, Type.Null()]),
  textColor: Type.Union([HexColor, Type.Null()]),
  fontFamily: FontSchema,
  themeMode: ThemeModeSchema,
  cornerRadius: Type.Integer({ minimum: 0, maximum: 32 }),
  socialLinks: Type.Record(Type.String(), Type.String()),
  bannerMessage: Type.Union([Type.String(), Type.Null()]),
  isCustomized: Type.Boolean(),
})

const BrandingInput = Type.Object({
  displayName: Type.Optional(Type.Union([Type.String({ maxLength: 80 }), Type.Null()])),
  tagline: Type.Optional(Type.Union([Type.String({ maxLength: 160 }), Type.Null()])),
  about: Type.Optional(Type.Union([Type.String({ maxLength: 2000 }), Type.Null()])),
  logoUrl: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
  logoDarkUrl: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
  faviconUrl: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
  coverUrl: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
  socialImageUrl: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
  primaryColor: Type.Optional(HexColor),
  primaryContrast: Type.Optional(HexColor),
  accentColor: Type.Optional(Type.Union([HexColor, Type.Null()])),
  backgroundColor: Type.Optional(Type.Union([HexColor, Type.Null()])),
  surfaceColor: Type.Optional(Type.Union([HexColor, Type.Null()])),
  textColor: Type.Optional(Type.Union([HexColor, Type.Null()])),
  fontFamily: Type.Optional(FontSchema),
  themeMode: Type.Optional(ThemeModeSchema),
  cornerRadius: Type.Optional(Type.Integer({ minimum: 0, maximum: 32 })),
  socialLinks: Type.Optional(SocialLinks),
  bannerMessage: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
})

/** Contrato: (row) -> Branding — normaliza o jsonb de resolve_branding. */
export function toBranding(row: Record<string, unknown>) {
  return {
    tenantId: String(row.tenantId),
    name: String(row.name),
    displayName: String(row.displayName),
    tagline: (row.tagline as string | null) ?? null,
    about: (row.about as string | null) ?? null,
    logoUrl: (row.logoUrl as string | null) ?? null,
    logoDarkUrl: (row.logoDarkUrl as string | null) ?? null,
    faviconUrl: (row.faviconUrl as string | null) ?? null,
    coverUrl: (row.coverUrl as string | null) ?? null,
    socialImageUrl: (row.socialImageUrl as string | null) ?? null,
    primaryColor: String(row.primaryColor),
    primaryContrast: String(row.primaryContrast),
    accentColor: (row.accentColor as string | null) ?? null,
    backgroundColor: (row.backgroundColor as string | null) ?? null,
    surfaceColor: (row.surfaceColor as string | null) ?? null,
    textColor: (row.textColor as string | null) ?? null,
    fontFamily: row.fontFamily as never,
    themeMode: row.themeMode as never,
    cornerRadius: Number(row.cornerRadius),
    socialLinks: (row.socialLinks ?? {}) as Record<string, string>,
    bannerMessage: (row.bannerMessage as string | null) ?? null,
    isCustomized: Boolean(row.isCustomized),
  }
}

/** Mapeia o corpo da API para as colunas do banco. */
const COLUMN_BY_FIELD: Record<string, string> = {
  displayName: 'display_name',
  logoUrl: 'logo_url',
  logoDarkUrl: 'logo_dark_url',
  faviconUrl: 'favicon_url',
  coverUrl: 'cover_url',
  socialImageUrl: 'social_image_url',
  primaryColor: 'primary_color',
  primaryContrast: 'primary_contrast',
  accentColor: 'accent_color',
  backgroundColor: 'background_color',
  surfaceColor: 'surface_color',
  textColor: 'text_color',
  fontFamily: 'font_family',
  themeMode: 'theme_mode',
  cornerRadius: 'corner_radius',
  socialLinks: 'social_links',
  bannerMessage: 'banner_message',
  tagline: 'tagline',
  about: 'about',
}

/** Contrato: (body) -> Record<string, unknown> — só os campos enviados. */
export function toBrandingColumns(body: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(body)) {
    const column = COLUMN_BY_FIELD[field]
    if (column && value !== undefined) patch[column] = value
  }
  return patch
}

const brandingRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/public/branding/:slug',
    {
      schema: {
        tags: ['identidade'],
        description:
          'Identidade visual do estabelecimento. Pública: o cardápio precisa dela antes de qualquer login.',
        params: Type.Object({ slug: Slug }),
        response: { 200: Branding, 404: ErrorResponse, 429: ErrorResponse },
      },
    },
    async (request) => {
      const { data, error } = await request.supabase.rpc('resolve_branding', {
        p_slug: request.params.slug,
      })
      if (error) throw app.httpErrors.internalServerError(error.message)
      if (!data) throw app.httpErrors.notFound('Estabelecimento não encontrado')

      return toBranding(data as Record<string, unknown>)
    },
  )

  app.put(
    '/branding',
    {
      onRequest: app.requirePermission('branding.write'),
      schema: {
        tags: ['identidade'],
        description: 'Cria ou atualiza a identidade visual do próprio estabelecimento.',
        body: BrandingInput,
        response: { 200: Type.Object({ updated: Type.Boolean() }), ...StandardErrors },
      },
    },
    async (request) => {
      const tenantId = request.requireTenantId()
      const patch = toBrandingColumns(request.body as Record<string, unknown>)

      const { error } = await request.supabase
        .from('tenant_branding')
        .upsert({ tenant_id: tenantId, ...patch }, { onConflict: 'tenant_id' })

      if (error) {
        // Os checks do banco recusam cor, fonte ou rede inválidas; a mensagem
        // é repassada porque explica exatamente o que foi rejeitado.
        throw app.httpErrors.badRequest(error.message)
      }
      return { updated: true }
    },
  )
}

export default brandingRoutes
