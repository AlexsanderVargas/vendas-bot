import { Type, type Static, type TSchema } from '@sinclair/typebox'

/**
 * Contratos base compartilhados entre API e Web.
 *
 * REGRA 4 (docs/engineering-rules.md): os schemas abaixo são contratos de
 * entrada/saída públicos. Alterações que quebrem compatibilidade exigem uma
 * nova versão do schema, nunca a mutação silenciosa do existente.
 */

export const Uuid = Type.String({ format: 'uuid', minLength: 36, maxLength: 36 })

/** Valor monetário em reais, 2 casas decimais. Serializado como número. */
export const Money = Type.Number({ minimum: 0, multipleOf: 0.01 })

export const Timestamp = Type.String({ format: 'date-time' })

/** Telefone no formato E.164 (mesmo check aplicado em customers.whatsapp). */
export const PhoneE164 = Type.String({ pattern: '^\\+[1-9][0-9]{7,14}$' })

export const Slug = Type.String({ pattern: '^[a-z0-9]([a-z0-9-]{1,58}[a-z0-9])?$' })

/** Corpo de erro padronizado devolvido por todas as rotas. */
export const ErrorResponse = Type.Object(
  {
    statusCode: Type.Integer(),
    error: Type.String(),
    message: Type.String(),
    code: Type.Optional(Type.String()),
    details: Type.Optional(Type.Unknown()),
  },
  { $id: 'ErrorResponse' },
)
export type ErrorResponse = Static<typeof ErrorResponse>

export const PaginationQuery = Type.Object({
  limit: Type.Integer({ minimum: 1, maximum: 100, default: 20 }),
  offset: Type.Integer({ minimum: 0, default: 0 }),
})
export type PaginationQuery = Static<typeof PaginationQuery>

/** Envelope de listagem paginada: { data: T[], total, limit, offset }. */
export const Paginated = <T extends TSchema>(item: T) =>
  Type.Object({
    data: Type.Array(item),
    total: Type.Integer({ minimum: 0 }),
    limit: Type.Integer({ minimum: 1 }),
    offset: Type.Integer({ minimum: 0 }),
  })

/** Respostas de erro padrão anexadas a toda rota autenticada. */
export const StandardErrors = {
  400: ErrorResponse,
  401: ErrorResponse,
  403: ErrorResponse,
  404: ErrorResponse,
  429: ErrorResponse,
  500: ErrorResponse,
} as const
