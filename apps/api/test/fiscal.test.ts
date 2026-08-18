import { describe, expect, it, vi } from 'vitest'
import { toFiscalDocument } from '../src/modules/fiscal/routes.js'
import { createHttpFiscalEmitter, mapEmissionStatus } from '../src/modules/fiscal/emitters/http.js'
import { FiscalEmitterError } from '../src/modules/fiscal/emitters/types.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('toFiscalDocument', () => {
  it('normaliza os numéricos do documento', () => {
    const document = toFiscalDocument({
      id: 'doc-1', order_id: 'ord-1', model: 'nfce', status: 'authorized',
      environment: 'homologation', series: 1, number: 42,
      access_key: '43260812345678000199650010000000421000000042',
      protocol: 'proto-1', total_amount: '56.80', total_taxes: '0.00',
      rejection_reason: null, danfe_url: null,
      authorized_at: '2026-08-18T12:00:00Z', canceled_at: null, attempts: 1,
    })
    expect(document.totalAmount).toBe(56.8)
    expect(document.number).toBe(42)
    expect(document.status).toBe('authorized')
  })

  it('mantém número nulo enquanto o documento não foi autorizado', () => {
    const document = toFiscalDocument({
      id: 'doc-2', order_id: 'ord-2', model: 'nfce', status: 'queued',
      environment: 'homologation', series: 1, number: null, access_key: null,
      protocol: null, total_amount: '10.00', total_taxes: '0',
      rejection_reason: null, danfe_url: null, authorized_at: null,
      canceled_at: null, attempts: 0,
    })
    expect(document.number).toBeNull()
    expect(document.accessKey).toBeNull()
  })
})

describe('mapEmissionStatus', () => {
  it('reconhece autorização em português e inglês', () => {
    expect(mapEmissionStatus('autorizado')).toBe('authorized')
    expect(mapEmissionStatus('AUTHORIZED')).toBe('authorized')
  })
  it('reconhece denegação', () => {
    expect(mapEmissionStatus('denegado')).toBe('denied')
  })
  it('reconhece contingência', () => {
    expect(mapEmissionStatus('contingencia')).toBe('contingency')
  })
  it('trata qualquer outro retorno como rejeição', () => {
    expect(mapEmissionStatus('erro_desconhecido')).toBe('rejected')
    expect(mapEmissionStatus('')).toBe('rejected')
  })
})

describe('emissor HTTP', () => {
  const REQUEST = {
    documentId: 'doc-1',
    model: 'nfce' as const,
    environment: 'homologation' as const,
    series: 1,
    payload: { items: [] },
  }

  it('envia o documento e mapeia a autorização', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({
        status: 'autorizado',
        chave: '43260812345678000199650010000000421000000042',
        protocolo: '143260000000042',
        danfe: 'https://emissor/danfe/1.pdf',
      }),
    )

    const emitter = createHttpFiscalEmitter({
      baseUrl: 'https://emissor.example',
      apiKey: 'chave',
      fetchImpl,
    })
    const result = await emitter.emit(REQUEST)

    expect(result.status).toBe('authorized')
    expect(result.accessKey).toBe('43260812345678000199650010000000421000000042')
    expect(result.protocol).toBe('143260000000042')
    expect(result.danfeUrl).toBe('https://emissor/danfe/1.pdf')

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://emissor.example/v2/nfce')
    const body = JSON.parse(init!.body as string)
    expect(body.reference).toBe('doc-1')
    expect(body.environment).toBe('homologation')
  })

  it('mapeia rejeição com código e motivo', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ status: 'rejeitado', codigo: '539', motivo: 'Duplicidade de NF-e' }),
    )
    const emitter = createHttpFiscalEmitter({
      baseUrl: 'https://emissor.example',
      apiKey: 'chave',
      fetchImpl,
    })
    const result = await emitter.emit(REQUEST)

    expect(result.status).toBe('rejected')
    expect(result.rejectionCode).toBe('539')
    expect(result.rejectionReason).toBe('Duplicidade de NF-e')
  })

  it('lança erro tipado quando o emissor devolve HTTP de erro', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ error: 'unauthorized' }, 401),
    )
    const emitter = createHttpFiscalEmitter({
      baseUrl: 'https://emissor.example',
      apiKey: 'ruim',
      fetchImpl,
    })
    await expect(emitter.emit(REQUEST)).rejects.toBeInstanceOf(FiscalEmitterError)
  })

  it('usa cabeçalho de autenticação próprio quando configurado', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ status: 'autorizado', chave: 'k', protocolo: 'p' }),
    )
    const emitter = createHttpFiscalEmitter({
      baseUrl: 'https://emissor.example',
      apiKey: 'chave-crua',
      authHeader: 'x-api-key',
      fetchImpl,
    })
    await emitter.emit(REQUEST)

    const headers = fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('chave-crua')
    expect(headers.authorization).toBeUndefined()
  })

  it('envia o cancelamento com a justificativa', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ status: 'autorizado', protocolo: 'cancel-1' }),
    )
    const emitter = createHttpFiscalEmitter({
      baseUrl: 'https://emissor.example',
      apiKey: 'chave',
      fetchImpl,
    })
    const result = await emitter.cancel({
      accessKey: '43260812345678000199650010000000421000000042',
      protocol: '143260000000042',
      reason: 'Cliente desistiu da compra apos a emissao',
      environment: 'homologation',
    })

    expect(result.accepted).toBe(true)
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)
    expect(body.justification).toContain('Cliente desistiu')
  })
})

describe('mapFiscalError', () => {
  it('mapeia tributação ausente para 400 com orientação', async () => {
    const { mapFiscalError } = await import('../src/modules/fiscal/routes.js')
    const mapped = mapFiscalError('tributacao_ausente')
    expect(mapped.status).toBe(400)
    expect(mapped.message).toContain('NCM/CFOP')
  })
  it('mapeia prazo expirado para 409', async () => {
    const { mapFiscalError } = await import('../src/modules/fiscal/routes.js')
    expect(mapFiscalError('prazo_expirado').status).toBe(409)
  })
  it('mapeia documento já existente para 409', async () => {
    const { mapFiscalError } = await import('../src/modules/fiscal/routes.js')
    expect(mapFiscalError('documento_ja_existe').status).toBe(409)
  })
  it('mapeia retorno incompleto do emissor para 502', async () => {
    const { mapFiscalError } = await import('../src/modules/fiscal/routes.js')
    expect(mapFiscalError('retorno_incompleto').status).toBe(502)
  })
  it('mapeia documento de outro tenant para 403', async () => {
    const { mapFiscalError } = await import('../src/modules/fiscal/routes.js')
    expect(mapFiscalError('nao_autorizado').status).toBe(403)
  })
})
