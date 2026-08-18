'use client'

import { useCallback, useEffect, useState } from 'react'
import { formatBRL } from '@vendas-bot/shared'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'
import { apiFetch, ApiError } from '@/lib/api'

interface PaymentOptions {
  defaultProvider: string | null
  allowOnDelivery: boolean
  providers: string[]
}

interface Payment {
  id: string
  provider: string
  status: string
  amount: number
  qrCode: string | null
  qrCodeBase64: string | null
  checkoutUrl: string | null
  expiresAt: string | null
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Aguardando pagamento',
  processing: 'Processando',
  approved: 'Pagamento confirmado',
  rejected: 'Pagamento recusado',
  refunded: 'Estornado',
  canceled: 'Cancelado',
  expired: 'Expirado',
}

/**
 * Cobrança on-line do pedido. O QR do PIX chega do gateway pelo backend, e a
 * confirmação aparece sozinha: a assinatura do Realtime observa a cobrança.
 */
export function PaymentPanel({
  orderId,
  tenantSlug,
  total,
  paymentStatus,
}: {
  orderId: string
  tenantSlug: string
  total: number
  paymentStatus: string
}) {
  const [options, setOptions] = useState<PaymentOptions | null>(null)
  const [payment, setPayment] = useState<Payment | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    void apiFetch<PaymentOptions>(`/public/payment-options?tenantSlug=${tenantSlug}`)
      .then(setOptions)
      .catch(() => setOptions(null))
  }, [tenantSlug])

  // Confirmação do PIX chega por Realtime, sem o cliente precisar recarregar.
  useEffect(() => {
    if (!payment) return
    const supabase = createClient()
    const channel = supabase
      .channel(`pagamento-${payment.id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'payments', filter: `id=eq.${payment.id}` },
        (payload) => {
          const row = payload.new as Record<string, unknown>
          setPayment((current) => (current ? { ...current, status: String(row.status) } : current))
        },
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [payment])

  const createPayment = useCallback(
    async (method: string) => {
      setCreating(true)
      setError(null)
      try {
        setPayment(
          await apiFetch<Payment>('/payments', {
            method: 'POST',
            body: JSON.stringify({ orderId, method }),
          }),
        )
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : 'Não foi possível gerar a cobrança.')
      } finally {
        setCreating(false)
      }
    },
    [orderId],
  )

  if (paymentStatus === 'paid') {
    return (
      <section className="rounded-xl border border-border p-4">
        <p className="font-medium">Pagamento confirmado</p>
        <p className="text-sm text-muted-foreground">Obrigado! Já recebemos {formatBRL(total)}.</p>
      </section>
    )
  }

  if (!options || options.providers.length === 0) {
    return options?.allowOnDelivery ? (
      <section className="rounded-xl border border-border p-4 text-sm">
        Pagamento na entrega ou na retirada.
      </section>
    ) : null
  }

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border p-4">
      <h3 className="font-semibold">Pagamento</h3>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {!payment ? (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void createPayment('pix')} disabled={creating}>
            {creating ? 'Gerando…' : `Pagar com PIX · ${formatBRL(total)}`}
          </Button>
          <Button variant="outline" onClick={() => void createPayment('credit_card')} disabled={creating}>
            Cartão de crédito
          </Button>
          {options.allowOnDelivery ? (
            <span className="self-center text-sm text-muted-foreground">
              ou pague na entrega
            </span>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            <strong>{STATUS_LABEL[payment.status] ?? payment.status}</strong>
          </p>

          {payment.qrCodeBase64 ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`data:image/png;base64,${payment.qrCodeBase64}`}
              alt="QR Code do PIX"
              className="h-48 w-48 self-start rounded-lg border border-border"
            />
          ) : null}

          {payment.qrCode ? (
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium" htmlFor="pix-copia-cola">
                PIX Copia e Cola
              </label>
              <textarea
                id="pix-copia-cola"
                readOnly
                value={payment.qrCode}
                rows={3}
                className="w-full rounded-lg border border-border bg-transparent p-2 text-xs"
              />
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                onClick={async () => {
                  await navigator.clipboard.writeText(payment.qrCode ?? '')
                  setCopied(true)
                  setTimeout(() => setCopied(false), 2000)
                }}
              >
                {copied ? 'Copiado!' : 'Copiar código'}
              </Button>
            </div>
          ) : null}

          {payment.checkoutUrl && !payment.qrCode ? (
            <a
              href={payment.checkoutUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-10 items-center self-start rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700"
            >
              Continuar o pagamento
            </a>
          ) : null}

          {payment.expiresAt ? (
            <p className="text-xs text-muted-foreground">
              Válido até {new Date(payment.expiresAt).toLocaleString('pt-BR')}
            </p>
          ) : null}
        </div>
      )}
    </section>
  )
}
