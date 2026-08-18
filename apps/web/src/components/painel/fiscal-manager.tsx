'use client'

import { useCallback, useEffect, useState } from 'react'
import { formatBRL } from '@vendas-bot/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { apiFetch, ApiError } from '@/lib/api'

interface FiscalDocument {
  id: string
  orderId: string
  model: 'nfce' | 'nfe'
  status: string
  environment: string
  series: number
  number: number | null
  accessKey: string | null
  totalAmount: number
  rejectionReason: string | null
  danfeUrl: string | null
  attempts: number
}

const STATUS_LABEL: Record<string, string> = {
  draft: 'Rascunho',
  queued: 'Na fila',
  transmitting: 'Transmitindo',
  authorized: 'Autorizado',
  rejected: 'Rejeitado',
  canceled: 'Cancelado',
  contingency: 'Contingência',
  denied: 'Denegado',
}

export function FiscalManager({ products }: { products: Array<{ id: string; name: string }> }) {
  const [documents, setDocuments] = useState<FiscalDocument[]>([])
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setDocuments(await apiFetch<FiscalDocument[]>('/fiscal/documents'))
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível carregar os documentos.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function saveProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const productId = String(form.get('productId') || '')
    setError(null)
    setMessage(null)
    try {
      await apiFetch('/fiscal/tax-profiles', {
        method: 'POST',
        body: JSON.stringify({
          productId: productId || null,
          isDefault: !productId,
          ncm: String(form.get('ncm')),
          cfop: String(form.get('cfop')),
          icmsCst: String(form.get('icmsCst') || '') || null,
          icmsRate: Number(form.get('icmsRate') || 0),
          commercialUnit: String(form.get('commercialUnit') || 'UN'),
        }),
      })
      setMessage(productId ? 'Tributação do produto salva.' : 'Tributação padrão salva.')
      event.currentTarget.reset()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível salvar a tributação.')
    }
  }

  return (
    <section className="flex flex-col gap-8">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {message ? <p className="text-sm">{message}</p> : null}

      <form onSubmit={saveProfile} className="flex flex-col gap-3 rounded-xl border border-border p-4">
        <h2 className="font-medium">Tributação</h2>
        <p className="text-xs text-muted-foreground">
          Deixe o produto em branco para definir o perfil padrão do estabelecimento — ele vale para
          todo produto que não tiver tributação própria.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <select
            name="productId"
            className="h-10 rounded-lg border border-border bg-transparent px-3 text-sm sm:col-span-2"
          >
            <option value="">Padrão do estabelecimento</option>
            {products.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
              </option>
            ))}
          </select>
          <Input name="ncm" placeholder="NCM (8 dígitos)" pattern="[0-9]{8}" required />
          <Input name="cfop" placeholder="CFOP (4 dígitos)" pattern="[0-9]{4}" required defaultValue="5102" />
          <Input name="icmsCst" placeholder="CST/CSOSN" />
          <Input name="icmsRate" type="number" step="0.01" min="0" max="100" placeholder="Alíquota ICMS %" />
          <Input name="commercialUnit" placeholder="Unidade (UN, KG)" defaultValue="UN" />
        </div>
        <Button type="submit">Salvar tributação</Button>
      </form>

      <div>
        <h2 className="mb-3 font-medium">Documentos fiscais</h2>
        {documents.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum documento emitido.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="py-2 pr-4 font-medium">Modelo</th>
                  <th className="py-2 pr-4 font-medium">Número</th>
                  <th className="py-2 pr-4 text-right font-medium">Valor</th>
                  <th className="py-2 pr-4 font-medium">Situação</th>
                  <th className="py-2 font-medium">Chave</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((document) => (
                  <tr key={document.id} className="border-b border-border/60">
                    <td className="py-2 pr-4 uppercase">{document.model}</td>
                    <td className="py-2 pr-4">
                      {document.number ? `${document.series}/${document.number}` : '—'}
                    </td>
                    <td className="py-2 pr-4 text-right">{formatBRL(document.totalAmount)}</td>
                    <td
                      className={`py-2 pr-4 ${
                        document.status === 'rejected' || document.status === 'denied'
                          ? 'text-destructive'
                          : ''
                      }`}
                    >
                      {STATUS_LABEL[document.status] ?? document.status}
                      {document.rejectionReason ? (
                        <span className="block text-xs">{document.rejectionReason}</span>
                      ) : null}
                      {document.attempts > 1 ? (
                        <span className="block text-xs text-muted-foreground">
                          {document.attempts} tentativas
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 font-mono text-xs">
                      {document.accessKey ? `…${document.accessKey.slice(-12)}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}
