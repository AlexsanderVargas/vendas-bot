/**
 * Porta do emissor fiscal.
 *
 * A emissão real de NFC-e/NF-e exige certificado digital A1/A3, credenciamento
 * na SEFAZ do estado e homologação — nada disso existe nesta base. O contrato
 * abaixo é o ponto de extensão: plugar um integrador (ou um emissor próprio)
 * significa implementar esta interface, sem tocar no resto do sistema.
 */

export type FiscalModel = 'nfce' | 'nfe'

export interface FiscalEmissionRequest {
  readonly documentId: string
  readonly model: FiscalModel
  readonly environment: 'production' | 'homologation'
  readonly series: number
  /** Conteúdo montado por public.build_fiscal_payload. */
  readonly payload: unknown
}

export interface FiscalEmissionResult {
  readonly status: 'authorized' | 'rejected' | 'denied' | 'contingency'
  readonly accessKey?: string | null
  readonly protocol?: string | null
  readonly rejectionCode?: string | null
  readonly rejectionReason?: string | null
  readonly xml?: string | null
  readonly danfeUrl?: string | null
  readonly raw?: unknown
}

export interface FiscalCancelRequest {
  readonly accessKey: string
  readonly protocol: string
  readonly reason: string
  readonly environment: 'production' | 'homologation'
}

export interface FiscalCancelResult {
  readonly accepted: boolean
  readonly protocol?: string | null
  readonly reason?: string | null
  readonly raw?: unknown
}

export interface FiscalEmitter {
  readonly name: string
  emit(request: FiscalEmissionRequest): Promise<FiscalEmissionResult>
  cancel(request: FiscalCancelRequest): Promise<FiscalCancelResult>
}

export class FiscalEmitterError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly providerResponse?: unknown,
  ) {
    super(message)
    this.name = 'FiscalEmitterError'
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>
