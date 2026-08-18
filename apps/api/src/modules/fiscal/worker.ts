import type { SupabaseClient } from '@supabase/supabase-js'
import { createHttpFiscalEmitter } from './emitters/http.js'
import type { FiscalEmitter, FiscalModel } from './emitters/types.js'

/** Linha devolvida por public.claim_fiscal_documents. */
interface ClaimedDocument {
  id: string
  tenant_id: string
  model: FiscalModel
  environment: 'production' | 'homologation'
  series: number
  request_payload: unknown
  attempts: number
}

/** Colunas de fiscal_settings que definem para onde transmitir. */
interface EmitterSettings {
  provider: string | null
  provider_api_key: string | null
  provider_base_url: string | null
}

export interface FiscalCycleSummary {
  claimed: number
  authorized: number
  rejected: number
  failed: number
}

export interface FiscalWorkerDeps {
  supabaseAdmin: SupabaseClient
  /** Injetável para o teste não precisar de rede. */
  buildEmitter?: (settings: EmitterSettings) => FiscalEmitter | null
  logger?: { warn: (details: unknown, message: string) => void }
  batchSize?: number
  staleAfter?: string
}

/**
 * Contrato: (settings) -> FiscalEmitter | null
 * Null quando o estabelecimento não tem integrador configurado — nesse caso
 * não há para onde transmitir, e insistir só encheria a fila de erro.
 */
export function defaultBuildEmitter(settings: EmitterSettings): FiscalEmitter | null {
  if (!settings.provider_api_key || !settings.provider_base_url) return null
  return createHttpFiscalEmitter({
    baseUrl: settings.provider_base_url,
    apiKey: settings.provider_api_key,
  })
}

/**
 * Contrato: (deps) -> Promise<FiscalCycleSummary>
 *
 * Um ciclo da fila: reivindica documentos prontos, transmite cada um e aplica
 * o retorno com mark_fiscal_result — que já cuida do backoff e do limite de
 * tentativas, então este código não reimplementa nenhum dos dois.
 *
 * Falha de um documento NÃO interrompe o ciclo: uma nota rejeitada por dado
 * inválido não pode travar a emissão de todas as outras. O erro vira um
 * 'rejected' com a mensagem do integrador, e o backoff decide se tenta de novo.
 */
export async function runFiscalCycle(deps: FiscalWorkerDeps): Promise<FiscalCycleSummary> {
  const { supabaseAdmin } = deps
  const buildEmitter = deps.buildEmitter ?? defaultBuildEmitter
  const summary: FiscalCycleSummary = { claimed: 0, authorized: 0, rejected: 0, failed: 0 }

  const { data, error } = await supabaseAdmin.rpc('claim_fiscal_documents', {
    p_limit: deps.batchSize ?? 10,
    p_stale_after: deps.staleAfter ?? '5 minutes',
  })

  if (error) throw new Error(`Falha ao reivindicar documentos fiscais: ${error.message}`)

  const documents = (data ?? []) as ClaimedDocument[]
  summary.claimed = documents.length
  if (documents.length === 0) return summary

  // Um estabelecimento costuma ter vários documentos na mesma leva; buscar a
  // configuração uma vez por tenant evita repetir a consulta por documento.
  const settingsByTenant = new Map<string, EmitterSettings | null>()

  for (const document of documents) {
    try {
      if (!settingsByTenant.has(document.tenant_id)) {
        const { data: settings } = await supabaseAdmin
          .from('fiscal_settings')
          .select('provider, provider_api_key, provider_base_url')
          .eq('tenant_id', document.tenant_id)
          .maybeSingle()
        settingsByTenant.set(document.tenant_id, (settings as EmitterSettings | null) ?? null)
      }

      const settings = settingsByTenant.get(document.tenant_id) ?? null
      const emitter = settings ? buildEmitter(settings) : null

      if (!emitter) {
        // Sem integrador não há transmissão possível. Registrar como rejeição
        // deixa o motivo visível no painel em vez de o documento sumir.
        await markResult(supabaseAdmin, document.id, {
          status: 'rejected',
          rejectionCode: 'sem_integrador',
          rejectionReason: 'Estabelecimento sem integrador fiscal configurado.',
        })
        summary.rejected += 1
        continue
      }

      const result = await emitter.emit({
        documentId: document.id,
        model: document.model,
        environment: document.environment,
        series: document.series,
        payload: document.request_payload,
      })

      await markResult(supabaseAdmin, document.id, result)
      if (result.status === 'authorized') summary.authorized += 1
      else summary.rejected += 1
    } catch (error) {
      summary.failed += 1
      deps.logger?.warn(
        { err: error, documentId: document.id },
        'Falha ao transmitir documento fiscal',
      )
      // Devolve o documento à fila pelo caminho normal: mark_fiscal_result
      // aplica o backoff e para de tentar ao atingir o limite configurado.
      await markResult(supabaseAdmin, document.id, {
        status: 'rejected',
        rejectionCode: 'falha_transmissao',
        rejectionReason: (error as Error).message,
      }).catch(() => undefined)
    }
  }

  return summary
}

interface ResultInput {
  status: 'authorized' | 'rejected' | 'denied' | 'contingency'
  accessKey?: string | null
  protocol?: string | null
  rejectionCode?: string | null
  rejectionReason?: string | null
  xml?: string | null
  danfeUrl?: string | null
  raw?: unknown
}

async function markResult(
  supabaseAdmin: SupabaseClient,
  documentId: string,
  result: ResultInput,
): Promise<void> {
  await supabaseAdmin.rpc('mark_fiscal_result', {
    p_document_id: documentId,
    p_status: result.status,
    p_access_key: result.accessKey ?? null,
    p_protocol: result.protocol ?? null,
    p_rejection_code: result.rejectionCode ?? null,
    p_rejection_reason: result.rejectionReason ?? null,
    p_response: result.raw ?? {},
    p_xml: result.xml ?? null,
    p_danfe_url: result.danfeUrl ?? null,
  })
}
