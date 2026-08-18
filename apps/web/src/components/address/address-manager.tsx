'use client'

import { useCallback, useEffect, useState } from 'react'
import { formatBRL } from '@vendas-bot/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { apiFetch, ApiError } from '@/lib/api'

export interface Address {
  id: string
  label: string
  street: string
  number: string
  complement: string | null
  neighborhood: string
  city: string
  state: string
  zipCode: string | null
  reference: string | null
  latitude: number | null
  longitude: number | null
  isDefault: boolean
}

interface DeliveryQuote {
  eligible: boolean
  fee: number
  mode: 'distance' | 'neighborhood' | 'fixed' | null
  distanceMeters: number | null
  etaMinutes: number | null
  minOrder: number
  reason: string | null
}

const REASON_LABEL: Record<string, string> = {
  estabelecimento_inativo: 'Estabelecimento indisponível no momento.',
  sem_localizacao: 'Informe a localização do endereço para calcularmos a entrega.',
  fora_da_area: 'Endereço fora da área de entrega.',
  bairro_nao_atendido: 'Ainda não entregamos neste bairro.',
  pedido_minimo: 'Pedido abaixo do mínimo para entrega.',
}

export function AddressManager({ tenantSlug }: { tenantSlug: string }) {
  const [addresses, setAddresses] = useState<Address[]>([])
  const [quotes, setQuotes] = useState<Record<string, DeliveryQuote>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await apiFetch<Address[]>(`/addresses?tenantSlug=${tenantSlug}`)
      setAddresses(list)
      const entries = await Promise.all(
        list.map(async (address) => {
          const quote = await apiFetch<DeliveryQuote>('/public/delivery/quote', {
            method: 'POST',
            body: JSON.stringify({
              tenantSlug,
              subtotal: 0,
              latitude: address.latitude,
              longitude: address.longitude,
              neighborhood: address.neighborhood,
              city: address.city,
            }),
          })
          return [address.id, quote] as const
        }),
      )
      setQuotes(Object.fromEntries(entries))
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível carregar os endereços.')
    } finally {
      setLoading(false)
    }
  }, [tenantSlug])

  useEffect(() => {
    void load()
  }, [load])

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setSaving(true)
    setError(null)
    try {
      await apiFetch<Address>('/addresses', {
        method: 'POST',
        body: JSON.stringify({
          tenantSlug,
          label: String(form.get('label') || 'Casa'),
          street: String(form.get('street')),
          number: String(form.get('number')),
          complement: String(form.get('complement') || '') || null,
          neighborhood: String(form.get('neighborhood')),
          city: String(form.get('city')),
          state: String(form.get('state')).toUpperCase(),
          zipCode: String(form.get('zipCode') || '').replace(/\D/g, '') || null,
          isDefault: addresses.length === 0,
        }),
      })
      event.currentTarget.reset()
      await load()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível salvar o endereço.')
    } finally {
      setSaving(false)
    }
  }

  async function setDefault(id: string) {
    await apiFetch<Address[]>(`/addresses/${id}/default?tenantSlug=${tenantSlug}`, { method: 'POST' })
    await load()
  }

  async function remove(id: string) {
    await apiFetch<null>(`/addresses/${id}`, { method: 'DELETE' })
    await load()
  }

  return (
    <section className="flex flex-col gap-8 py-8">
      <div>
        <h2 className="mb-4 text-lg font-semibold">Meus endereços</h2>
        {loading ? (
          <p className="text-sm text-muted-foreground">Carregando…</p>
        ) : addresses.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum endereço cadastrado ainda.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {addresses.map((address) => {
              const quote = quotes[address.id]
              return (
                <li key={address.id} className="rounded-xl border border-border p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-medium">
                        {address.label}
                        {address.isDefault ? (
                          <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs">Padrão</span>
                        ) : null}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {address.street}, {address.number}
                        {address.complement ? ` · ${address.complement}` : ''} — {address.neighborhood},{' '}
                        {address.city}/{address.state}
                      </p>
                      {quote ? (
                        <p className="mt-1 text-sm">
                          {quote.eligible || quote.reason === 'pedido_minimo' ? (
                            <>
                              Entrega {formatBRL(quote.fee)}
                              {quote.etaMinutes ? ` · ~${quote.etaMinutes} min` : ''}
                              {quote.distanceMeters
                                ? ` · ${(quote.distanceMeters / 1000).toFixed(1)} km`
                                : ''}
                            </>
                          ) : (
                            <span className="text-destructive">
                              {REASON_LABEL[quote.reason ?? ''] ?? 'Endereço indisponível para entrega.'}
                            </span>
                          )}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-col gap-2">
                      {!address.isDefault ? (
                        <Button variant="outline" size="sm" onClick={() => void setDefault(address.id)}>
                          Tornar padrão
                        </Button>
                      ) : null}
                      <Button variant="ghost" size="sm" onClick={() => void remove(address.id)}>
                        Remover
                      </Button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-xl border border-border p-4">
        <h3 className="font-medium">Novo endereço</h3>
        <div className="grid grid-cols-2 gap-3">
          <Input name="label" placeholder="Apelido (Casa, Trabalho)" defaultValue="Casa" />
          <Input name="zipCode" placeholder="CEP" inputMode="numeric" />
          <Input name="street" placeholder="Rua" required className="col-span-2" />
          <Input name="number" placeholder="Número" required />
          <Input name="complement" placeholder="Complemento" />
          <Input name="neighborhood" placeholder="Bairro" required />
          <Input name="city" placeholder="Cidade" required />
          <Input name="state" placeholder="UF" maxLength={2} required />
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={saving}>
          {saving ? 'Salvando…' : 'Salvar endereço'}
        </Button>
      </form>
    </section>
  )
}
