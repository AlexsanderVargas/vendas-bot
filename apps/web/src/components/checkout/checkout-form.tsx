'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { MenuTenant } from '@vendas-bot/shared'
import {
  formatBRL,
  formatDocument,
  googleMapsLink,
  haversineMeters,
  normalizeDocument,
  wazeLink,
} from '@vendas-bot/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { apiFetch, ApiError } from '@/lib/api'
import { useCart } from '@/lib/cart/cart-context'
import type { Address } from '@/components/address/address-manager'

type Channel = 'delivery' | 'takeaway'

interface DeliveryQuote {
  eligible: boolean
  fee: number
  etaMinutes: number | null
  distanceMeters: number | null
  minOrder: number
  reason: string | null
}

interface CheckoutResult {
  id: string
  orderNumber: number
}

export function CheckoutForm({ tenant }: { tenant: MenuTenant }) {
  const router = useRouter()
  const { items, subtotal, clear } = useCart()

  const [channel, setChannel] = useState<Channel>('delivery')
  const [addresses, setAddresses] = useState<Address[]>([])
  const [addressId, setAddressId] = useState<string | null>(null)
  const [quote, setQuote] = useState<DeliveryQuote | null>(null)
  const [notes, setNotes] = useState('')
  const [taxId, setTaxId] = useState('')
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [position, setPosition] = useState<{ latitude: number; longitude: number } | null>(null)

  useEffect(() => {
    void apiFetch<Address[]>(`/addresses?tenantSlug=${tenant.slug}`)
      .then((list) => {
        setAddresses(list)
        setAddressId(list.find((address) => address.isDefault)?.id ?? list[0]?.id ?? null)
      })
      .catch(() => setAddresses([]))
  }, [tenant.slug])

  // Distância atual do cliente até o restaurante, exibida no modo retirada.
  useEffect(() => {
    if (channel !== 'takeaway' || !tenant.location || !navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      (result) =>
        setPosition({ latitude: result.coords.latitude, longitude: result.coords.longitude }),
      () => setPosition(null),
      { timeout: 8000 },
    )
  }, [channel, tenant.location])

  const refreshQuote = useCallback(async () => {
    if (channel !== 'delivery') {
      setQuote(null)
      return
    }
    const address = addresses.find((candidate) => candidate.id === addressId)
    if (!address) {
      setQuote(null)
      return
    }
    try {
      setQuote(
        await apiFetch<DeliveryQuote>('/public/delivery/quote', {
          method: 'POST',
          body: JSON.stringify({
            tenantSlug: tenant.slug,
            subtotal,
            latitude: address.latitude,
            longitude: address.longitude,
            neighborhood: address.neighborhood,
            city: address.city,
          }),
        }),
      )
      setQuoteError(null)
    } catch {
      setQuote(null)
      // Sem isto o botão fica desabilitado e o cliente não descobre por quê:
      // ele abandona o carrinho achando que o site está quebrado.
      setQuoteError(
        'Não foi possível calcular a taxa de entrega agora. Tente novamente em instantes ou escolha retirada.',
      )
    }
  }, [channel, addresses, addressId, subtotal, tenant.slug])

  useEffect(() => {
    void refreshQuote()
  }, [refreshQuote])

  const deliveryFee = channel === 'delivery' ? (quote?.fee ?? 0) : 0
  const total = subtotal + deliveryFee
  const blocked =
    items.length === 0 ||
    (channel === 'delivery' && (!addressId || !quote || !quote.eligible))

  async function submit() {
    setSubmitting(true)
    setError(null)
    try {
      // O documento é do cliente, não do pedido: fica guardado no cadastro e
      // vale para as próximas compras. Salvo antes de criar o pedido para que
      // a cobrança já o encontre.
      const trimmedTaxId = taxId.trim()
      if (trimmedTaxId) {
        if (!normalizeDocument(trimmedTaxId)) {
          setError('CPF ou CNPJ inválido. Confira os números ou deixe o campo em branco.')
          setSubmitting(false)
          return
        }
        await apiFetch<{ document: string | null }>('/me/document', {
          method: 'PUT',
          body: JSON.stringify({ tenantSlug: tenant.slug, document: trimmedTaxId }),
        })
      }

      const order = await apiFetch<CheckoutResult>('/orders/checkout', {
        method: 'POST',
        body: JSON.stringify({
          tenantSlug: tenant.slug,
          channel,
          addressId: channel === 'delivery' ? addressId : null,
          notes: notes.trim() || null,
          items: items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
            notes: item.notes,
            optionIds: item.selectedOptions.map((option) => option.optionId),
          })),
        }),
      })
      clear()
      router.push(`/${tenant.slug}/pedidos/${order.id}`)
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível concluir o pedido.')
      setSubmitting(false)
    }
  }

  if (items.length === 0) {
    return (
      <p className="py-12 text-center text-muted-foreground">
        Seu carrinho está vazio.{' '}
        <Link href={`/${tenant.slug}`} className="underline">
          Voltar ao cardápio
        </Link>
        .
      </p>
    )
  }

  const tenantAddress = [
    tenant.address.street && `${tenant.address.street}, ${tenant.address.number ?? 's/n'}`,
    tenant.address.neighborhood,
    tenant.address.city,
  ]
    .filter(Boolean)
    .join(' — ')

  return (
    <div className="flex flex-col gap-8 py-8">
      <section>
        <h2 className="mb-3 text-lg font-semibold">Como você quer receber?</h2>
        <div className="flex gap-2">
          {(['delivery', 'takeaway'] as const).map((option) => (
            <Button
              key={option}
              variant={channel === option ? 'default' : 'outline'}
              onClick={() => setChannel(option)}
            >
              {option === 'delivery' ? 'Entrega' : 'Retirada'}
            </Button>
          ))}
        </div>
      </section>

      {channel === 'delivery' ? (
        <section>
          <h2 className="mb-3 text-lg font-semibold">Endereço de entrega</h2>
          {addresses.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Você ainda não tem endereços.{' '}
              <Link href={`/${tenant.slug}/enderecos`} className="underline">
                Cadastrar endereço
              </Link>
              .
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {addresses.map((address) => (
                <li key={address.id}>
                  <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 text-sm hover:bg-muted">
                    <input
                      type="radio"
                      name="address"
                      className="mt-1"
                      checked={addressId === address.id}
                      onChange={() => setAddressId(address.id)}
                    />
                    <span>
                      <strong>{address.label}</strong> — {address.street}, {address.number} ·{' '}
                      {address.neighborhood}, {address.city}/{address.state}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {quote && !quote.eligible ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {quote.reason === 'pedido_minimo'
                ? `Pedido mínimo de ${formatBRL(quote.minOrder)} para entrega neste endereço.`
                : 'Não entregamos neste endereço.'}
            </p>
          ) : null}
        </section>
      ) : (
        <section>
          <h2 className="mb-3 text-lg font-semibold">Retirada no local</h2>
          <p className="text-sm text-muted-foreground">{tenantAddress || tenant.name}</p>
          {position && tenant.location ? (
            <p className="mt-1 text-sm text-muted-foreground">
              Você está a {(haversineMeters(position, tenant.location) / 1000).toFixed(1)} km daqui.
            </p>
          ) : null}
          <div className="mt-3 flex gap-2">
            <a
              href={googleMapsLink(tenant.location ?? tenantAddress)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center rounded-lg border border-border px-3 text-sm hover:bg-muted"
            >
              Abrir no Google Maps
            </a>
            {tenant.location ? (
              <a
                href={wazeLink(tenant.location)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-9 items-center rounded-lg border border-border px-3 text-sm hover:bg-muted"
              >
                Abrir no Waze
              </a>
            ) : null}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-lg font-semibold">Resumo</h2>
        <ul className="flex flex-col gap-2 text-sm">
          {items.map((item) => (
            <li key={item.lineId} className="flex justify-between gap-3">
              <span>
                {item.quantity}× {item.productName}
                {item.selectedOptions.length > 0 ? (
                  <span className="block text-xs text-muted-foreground">
                    {item.selectedOptions.map((option) => option.optionName).join(' · ')}
                  </span>
                ) : null}
              </span>
              <span>{formatBRL(item.unitPrice * item.quantity)}</span>
            </li>
          ))}
        </ul>
        <dl className="mt-4 flex flex-col gap-1 border-t border-border pt-4 text-sm">
          <div className="flex justify-between">
            <dt>Subtotal</dt>
            <dd>{formatBRL(subtotal)}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Entrega</dt>
            <dd>{channel === 'delivery' ? formatBRL(deliveryFee) : 'Retirada'}</dd>
          </div>
          <div className="flex justify-between text-base font-semibold">
            <dt>Total</dt>
            <dd>{formatBRL(total)}</dd>
          </div>
          {quote?.etaMinutes ? (
            <p className="pt-1 text-muted-foreground">Previsão: ~{quote.etaMinutes} min</p>
          ) : null}
        </dl>
      </section>

      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Observações do pedido
        <Input
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Ex.: interfone quebrado, ligar ao chegar"
          maxLength={500}
        />
      </label>

      <label className="flex flex-col gap-1.5 text-sm font-medium">
        CPF ou CNPJ na nota{' '}
        <span className="font-normal text-muted-foreground">(opcional)</span>
        <Input
          value={taxId}
          inputMode="numeric"
          autoComplete="off"
          onChange={(event) => setTaxId(event.target.value)}
          onBlur={(event) => setTaxId(formatDocument(event.target.value))}
          placeholder="000.000.000-00"
          maxLength={20}
          aria-describedby="ajuda-documento"
        />
        <span id="ajuda-documento" className="text-xs font-normal text-muted-foreground">
          Só é necessário se você quer o documento na nota fiscal. Fica salvo para as
          próximas compras.
        </span>
      </label>

      {quoteError && channel === 'delivery' ? (
        <div role="alert" className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
          <p className="text-sm text-destructive">{quoteError}</p>
          <button
            type="button"
            onClick={() => void refreshQuote()}
            className="self-start text-sm font-medium underline underline-offset-4"
          >
            Recalcular
          </button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <Button size="lg" onClick={() => void submit()} disabled={blocked || submitting}>
        {submitting ? 'Enviando…' : `Confirmar pedido · ${formatBRL(total)}`}
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        O valor final é recalculado no servidor antes da confirmação.
      </p>
    </div>
  )
}
