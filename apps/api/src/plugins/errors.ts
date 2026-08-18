import fp from 'fastify-plugin'
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ErrorResponse } from '@vendas-bot/shared'

/**
 * Handler de erros padronizado.
 * Contrato de saída (ErrorResponse): { statusCode, error, message, code?, details? }
 * Detalhes internos nunca vazam em produção — 5xx vira mensagem genérica.
 */
export default fp(
  async function errorsPlugin(app: FastifyInstance) {
    app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
      const body: ErrorResponse = {
        statusCode: 404,
        error: 'Not Found',
        message: `Rota não encontrada: ${request.method} ${request.url}`,
      }
      reply.status(404).send(body)
    })

    app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
      const statusCode = error.statusCode ?? 500

      if (statusCode >= 500) {
        request.log.error({ err: error }, 'Erro não tratado')
      } else {
        request.log.info({ err: error.message, statusCode }, 'Requisição rejeitada')
      }

      const body: ErrorResponse = {
        statusCode,
        error: nameFor(statusCode),
        message:
          statusCode >= 500 && app.config.nodeEnv === 'production'
            ? 'Erro interno do servidor'
            : error.message,
        ...(error.code ? { code: error.code } : {}),
        ...(error.validation ? { details: error.validation } : {}),
      }
      reply.status(statusCode).send(body)
    })
  },
  { name: 'errors' },
)

function nameFor(statusCode: number): string {
  const names: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    422: 'Unprocessable Entity',
    429: 'Too Many Requests',
  }
  return names[statusCode] ?? (statusCode >= 500 ? 'Internal Server Error' : 'Error')
}
