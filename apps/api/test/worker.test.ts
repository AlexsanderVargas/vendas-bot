import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { runFiscalCycle, defaultBuildEmitter } from '../src/modules/fiscal/worker.js'
import { runSyncCycle, SyncCycleError } from '../src/modules/integrations/service.js'
import type { IntegrationRecord } from '../src/modules/integrations/service.js'
import type { FiscalEmitter } from '../src/modules/fiscal/emitters/types.js'
import { createFakeSupabase, type TableRows } from './fake-supabase.js'
import { TENANT_A } from './helpers.js'

const DOC_A = 'dd000000-0000-0000-0000-00000000000a'
const DOC_B = 'dd000000-0000-0000-0000-00000000000b'
const INTEGRATION_ID = '11100000-0000-0000-0000-000000000001'

const SETTINGS: TableRows = {
  fiscal_settings: [
    {
      tenant_id: TENANT_A,
      provider: 'focus',
      provider_api_key: 'chave-sandbox',
      provider_base_url: 'https://sandbox.integrador.test',
    },
  ],
}

function claimed(ids: string[]) {
  return ids.map((id) => ({
    id,
    tenant_id: TENANT_A,
    model: 'nfce',
    environment: 'homologation',
    series: 1,
    request_payload: { items: [] },
    attempts: 0,
  }))
}

/** Emissor de mentira: devolve o que o teste mandar, sem rede. */
function fakeEmitter(behaviour: (documentId: string) => unknown): FiscalEmitter {
  return {
    name: 'fake',
    emit: vi.fn(async (request: { documentId: string }) => {
      const result = behaviour(request.documentId)
      if (result instanceof Error) throw result
      return result as never
    }),
    cancel: vi.fn(async () => ({ accepted: true })),
  }
}

// ------------------------------------------------------------- fila fiscal ---
describe('ciclo da fila fiscal', () => {
  it('fila vazia não chama o integrador', async () => {
    const emit = vi.fn()
    const supabase = createFakeSupabase(SETTINGS, { claim_fiscal_documents: () => [] })

    const summary = await runFiscalCycle({
      supabaseAdmin: supabase,
      buildEmitter: () => ({ name: 'x', emit, cancel: vi.fn() }) as unknown as FiscalEmitter,
    })

    expect(summary.claimed).toBe(0)
    expect(emit).not.toHaveBeenCalled()
  })

  it('documento autorizado é contabilizado e o retorno é aplicado', async () => {
    const marked: Record<string, unknown>[] = []
    const supabase = createFakeSupabase(SETTINGS, {
      claim_fiscal_documents: () => claimed([DOC_A]),
      mark_fiscal_result: (params) => {
        marked.push(params)
        return { ok: true }
      },
    })

    const summary = await runFiscalCycle({
      supabaseAdmin: supabase,
      buildEmitter: () =>
        fakeEmitter(() => ({
          status: 'authorized',
          accessKey: '1'.repeat(44),
          protocol: 'PROT-9',
        })),
    })

    expect(summary).toMatchObject({ claimed: 1, authorized: 1, rejected: 0, failed: 0 })
    expect(marked[0]).toMatchObject({
      p_document_id: DOC_A,
      p_status: 'authorized',
      p_protocol: 'PROT-9',
    })
  })

  it('rejeição é registrada com código e motivo do integrador', async () => {
    const marked: Record<string, unknown>[] = []
    const supabase = createFakeSupabase(SETTINGS, {
      claim_fiscal_documents: () => claimed([DOC_A]),
      mark_fiscal_result: (params) => {
        marked.push(params)
        return { ok: true }
      },
    })

    const summary = await runFiscalCycle({
      supabaseAdmin: supabase,
      buildEmitter: () =>
        fakeEmitter(() => ({
          status: 'rejected',
          rejectionCode: '539',
          rejectionReason: 'Duplicidade de NF-e',
        })),
    })

    expect(summary.rejected).toBe(1)
    expect(marked[0]).toMatchObject({ p_rejection_code: '539' })
  })

  it('falha de um documento não interrompe os seguintes', async () => {
    // Uma nota com dado inválido não pode travar a emissão de todas as outras.
    const marked: Record<string, unknown>[] = []
    const supabase = createFakeSupabase(SETTINGS, {
      claim_fiscal_documents: () => claimed([DOC_A, DOC_B]),
      mark_fiscal_result: (params) => {
        marked.push(params)
        return { ok: true }
      },
    })

    const summary = await runFiscalCycle({
      supabaseAdmin: supabase,
      buildEmitter: () =>
        fakeEmitter((id) =>
          id === DOC_A
            ? new Error('integrador fora do ar')
            : { status: 'authorized', accessKey: '2'.repeat(44), protocol: 'PROT-2' },
        ),
    })

    expect(summary).toMatchObject({ claimed: 2, authorized: 1, failed: 1 })
    expect(marked).toHaveLength(2)
  })

  it('falha de transmissão devolve o documento à fila pelo caminho normal', async () => {
    // Devolver por mark_fiscal_result é o que preserva o backoff e o limite
    // de tentativas — reimplementar isso aqui duplicaria a regra.
    const marked: Record<string, unknown>[] = []
    const supabase = createFakeSupabase(SETTINGS, {
      claim_fiscal_documents: () => claimed([DOC_A]),
      mark_fiscal_result: (params) => {
        marked.push(params)
        return { ok: true }
      },
    })

    await runFiscalCycle({
      supabaseAdmin: supabase,
      buildEmitter: () => fakeEmitter(() => new Error('timeout')),
    })

    expect(marked[0]).toMatchObject({
      p_status: 'rejected',
      p_rejection_code: 'falha_transmissao',
      p_rejection_reason: 'timeout',
    })
  })

  it('estabelecimento sem integrador recebe motivo visível, não silêncio', async () => {
    const marked: Record<string, unknown>[] = []
    const supabase = createFakeSupabase(
      { fiscal_settings: [{ tenant_id: TENANT_A, provider: null, provider_api_key: null, provider_base_url: null }] },
      {
        claim_fiscal_documents: () => claimed([DOC_A]),
        mark_fiscal_result: (params) => {
          marked.push(params)
          return { ok: true }
        },
      },
    )

    const summary = await runFiscalCycle({ supabaseAdmin: supabase })

    expect(summary.rejected).toBe(1)
    expect(marked[0]).toMatchObject({ p_rejection_code: 'sem_integrador' })
  })

  it('erro ao reivindicar aborta o ciclo com mensagem clara', async () => {
    const supabase = {
      rpc: async () => ({ data: null, error: { message: 'permission denied' } }),
    } as unknown as SupabaseClient

    await expect(runFiscalCycle({ supabaseAdmin: supabase })).rejects.toThrow(
      /Falha ao reivindicar documentos fiscais/,
    )
  })
})

describe('defaultBuildEmitter', () => {
  it('sem chave ou endereço não monta emissor', () => {
    expect(
      defaultBuildEmitter({ provider: 'focus', provider_api_key: null, provider_base_url: 'https://x' }),
    ).toBeNull()
    expect(
      defaultBuildEmitter({ provider: 'focus', provider_api_key: 'k', provider_base_url: null }),
    ).toBeNull()
  })

  it('com os dois, monta o cliente HTTP', () => {
    const emitter = defaultBuildEmitter({
      provider: 'focus',
      provider_api_key: 'k',
      provider_base_url: 'https://sandbox.integrador.test',
    })
    expect(emitter?.name).toBe('http')
  })
})

// ---------------------------------------------------------- runSyncCycle -----
describe('runSyncCycle', () => {
  const INTEGRATION: IntegrationRecord = {
    id: INTEGRATION_ID,
    tenant_id: TENANT_A,
    channel: 'ifood',
    external_store_id: 'merchant-abc',
    auto_accept: false,
    is_receiving: true,
  }

  it('integração sem credenciais falha com motivo próprio', async () => {
    // A rota traduz esse motivo em 400 e o worker apenas registra — por isso
    // o motivo é tipado em vez de virar texto solto.
    const supabase = createFakeSupabase({ integration_credentials: [] })

    await expect(
      runSyncCycle({ integration: INTEGRATION, supabaseAdmin: supabase }),
    ).rejects.toMatchObject({ reason: 'sem_credenciais' })
  })

  it('o erro é do tipo que a rota sabe traduzir', async () => {
    const supabase = createFakeSupabase({ integration_credentials: [] })
    const error = await runSyncCycle({
      integration: INTEGRATION,
      supabaseAdmin: supabase,
    }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(SyncCycleError)
  })
})
