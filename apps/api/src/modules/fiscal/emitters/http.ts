import type {
  FetchLike,
  FiscalCancelRequest,
  FiscalCancelResult,
  FiscalEmissionRequest,
  FiscalEmissionResult,
  FiscalEmitter,
} from './types.js'
import { FiscalEmitterError } from './types.js'
import { withTimeout } from '../../../lib/fetch-timeout.js'

/**
 * Emissor genérico sobre HTTP.
 *
 * Os integradores fiscais brasileiros (Focus NFe, NFe.io, WebmaniaBR, Tecnospeed
 * e afins) expõem APIs REST parecidas: POST do documento, retorno com chave de
 * acesso, protocolo e situação. Este cliente cobre esse formato comum e mapeia
 * a resposta para o vocabulário do sistema.
 *
 * NÃO FOI HOMOLOGADO contra nenhum integrador: sem credencial e sem
 * certificado, não há como exercitar o caminho real. Ao escolher o
 * integrador, ajuste `paths` e `mapStatus` conforme a documentação dele.
 */
export interface HttpFiscalEmitterOptions {
  /** Prazo por chamada, em ms. Padrão: 20s. */
  readonly timeoutMs?: number
  readonly baseUrl: string
  readonly apiKey: string
  readonly fetchImpl?: FetchLike
  /** Cabeçalho de autenticação: alguns usam Bearer, outros um header próprio. */
  readonly authHeader?: string
  readonly emitPath?: string
  readonly cancelPath?: string
}

/** Contrato: (status) -> FiscalEmissionResult['status'] */
export function mapEmissionStatus(status: string): FiscalEmissionResult['status'] {
  const normalized = status.toLowerCase()
  if (['autorizado', 'authorized', 'aprovado', 'succeeded'].includes(normalized)) return 'authorized'
  if (['denegado', 'denied'].includes(normalized)) return 'denied'
  if (['contingencia', 'contingency', 'offline'].includes(normalized)) return 'contingency'
  return 'rejected'
}

export function createHttpFiscalEmitter(options: HttpFiscalEmitterOptions): FiscalEmitter {
  // Prazo obrigatório: sem ele um parceiro pendurado congela o worker
  // inteiro, e nenhum estabelecimento recebe pedido.
  const fetchImpl = withTimeout(options.fetchImpl ?? fetch, options.timeoutMs)
  const authHeader = options.authHeader ?? 'authorization'
  const emitPath = options.emitPath ?? '/v2/nfce'
  const cancelPath = options.cancelPath ?? '/v2/nfce/cancel'

  const headers = {
    [authHeader]: authHeader === 'authorization' ? `Bearer ${options.apiKey}` : options.apiKey,
    'content-type': 'application/json',
  }

  return {
    name: 'http',

    async emit(request: FiscalEmissionRequest): Promise<FiscalEmissionResult> {
      const response = await fetchImpl(`${options.baseUrl}${emitPath}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          reference: request.documentId,
          model: request.model,
          environment: request.environment,
          series: request.series,
          data: request.payload,
        }),
      })

      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null

      if (!response.ok || !body) {
        throw new FiscalEmitterError(
          `Emissor recusou a requisição (HTTP ${response.status})`,
          response.status,
          body,
        )
      }

      const status = mapEmissionStatus(String(body.status ?? body.situacao ?? ''))

      return {
        status,
        accessKey: (body.access_key ?? body.chave ?? null) as string | null,
        protocol: (body.protocol ?? body.protocolo ?? null) as string | null,
        rejectionCode: (body.status_code ?? body.codigo ?? null) as string | null,
        rejectionReason: (body.message ?? body.motivo ?? null) as string | null,
        xml: (body.xml ?? null) as string | null,
        danfeUrl: (body.danfe_url ?? body.danfe ?? null) as string | null,
        raw: body,
      }
    },

    async cancel(request: FiscalCancelRequest): Promise<FiscalCancelResult> {
      const response = await fetchImpl(`${options.baseUrl}${cancelPath}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          access_key: request.accessKey,
          protocol: request.protocol,
          justification: request.reason,
          environment: request.environment,
        }),
      })

      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null

      if (!response.ok || !body) {
        throw new FiscalEmitterError(
          `Emissor recusou o cancelamento (HTTP ${response.status})`,
          response.status,
          body,
        )
      }

      return {
        accepted: mapEmissionStatus(String(body.status ?? '')) !== 'rejected',
        protocol: (body.protocol ?? body.protocolo ?? null) as string | null,
        reason: (body.message ?? body.motivo ?? null) as string | null,
        raw: body,
      }
    },
  }
}
