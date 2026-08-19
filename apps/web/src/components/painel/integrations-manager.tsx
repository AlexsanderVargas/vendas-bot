'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { apiFetch, ApiError } from '@/lib/api'

type Channel = 'ifood' | 'ubereats'

interface Integration {
  id: string
  channel: Channel
  status: 'disconnected' | 'connected' | 'error' | 'paused'
  externalStoreId: string | null
  storeName: string | null
  autoAccept: boolean
  isReceiving: boolean
  lastSyncAt: string | null
  lastError: string | null
  hasCredentials: boolean
}

interface ItemMap {
  id: string
  productId: string | null
  externalItemId: string
  externalName: string | null
}

interface IntegrationEvent {
  id: string
  eventCode: string
  externalOrderId: string | null
  processedAt: string | null
  error: string | null
  createdAt: string
}

interface SyncSummary {
  polled: number
  ingested: number
  duplicated: number
  failed: number
  unmapped: string[]
}

const CHANNEL_LABEL: Record<Channel, string> = {
  ifood: 'iFood',
  ubereats: 'Uber Eats',
}

const STATUS_LABEL: Record<Integration['status'], string> = {
  disconnected: 'Desconectado',
  connected: 'Conectado',
  error: 'Com erro',
  paused: 'Pausado',
}

/** O iFood entrega por polling; o Uber Eats, por webhook. */
const CHANNEL_DELIVERY_MODE: Record<Channel, string> = {
  ifood: 'Recebe por consulta periódica (polling). Use "Sincronizar agora" ou agende o ciclo.',
  ubereats: 'Recebe por webhook. Configure a URL /api/v1/webhooks/marketplace/ubereats no parceiro.',
}

export function IntegrationsManager({ products }: { products: Array<{ id: string; name: string }> }) {
  const [integrations, setIntegrations] = useState<Integration[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [items, setItems] = useState<ItemMap[]>([])
  const [events, setEvents] = useState<IntegrationEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      const list = await apiFetch<Integration[]>('/integrations')
      setIntegrations(list)
      setSelected((current) => current ?? list[0]?.id ?? null)
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível carregar as integrações.')
    }
  }, [])

  const loadDetails = useCallback(async () => {
    if (!selected) return
    try {
      const [itemList, eventList] = await Promise.all([
        apiFetch<ItemMap[]>(`/integrations/${selected}/items`),
        apiFetch<IntegrationEvent[]>(`/integrations/${selected}/events`),
      ])
      setItems(itemList)
      setEvents(eventList)
    } catch {
      setItems([])
      setEvents([])
    }
  }, [selected])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void loadDetails()
  }, [loadDetails])

  const current = integrations.find((integration) => integration.id === selected) ?? null

  async function connect(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // O elemento precisa ser capturado ANTES do await: o React anula
    // event.currentTarget quando o handler síncrono termina, e chamar
    // .reset() depois lançaria TypeError — exibindo erro de falha em um
    // salvamento que deu certo.
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    setError(null)
    setMessage(null)
    try {
      await apiFetch('/integrations', {
        method: 'POST',
        body: JSON.stringify({
          channel: String(form.get('channel')),
          externalStoreId: String(form.get('externalStoreId')),
          storeName: String(form.get('storeName') || '') || null,
          clientId: String(form.get('clientId')),
          clientSecret: String(form.get('clientSecret')),
          webhookSecret: String(form.get('webhookSecret') || '') || null,
        }),
      })
      setMessage('Canal conectado. As credenciais ficam apenas no servidor.')
      formElement.reset()
      await load()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível conectar o canal.')
    }
  }

  async function toggleReceiving(integration: Integration) {
    try {
      await apiFetch(`/integrations/${integration.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isReceiving: !integration.isReceiving }),
      })
      await load()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível alterar o canal.')
    }
  }

  async function toggleAutoAccept(integration: Integration) {
    try {
      await apiFetch(`/integrations/${integration.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ autoAccept: !integration.autoAccept }),
      })
      await load()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível alterar o canal.')
    }
  }

  async function sync() {
    if (!selected) return
    setSyncing(true)
    setError(null)
    setMessage(null)
    try {
      const summary = await apiFetch<SyncSummary>(`/integrations/${selected}/sync`, { method: 'POST' })
      setMessage(
        `Sincronizado: ${summary.polled} evento(s), ${summary.ingested} pedido(s) novo(s)` +
          (summary.duplicated > 0 ? `, ${summary.duplicated} já conhecido(s)` : '') +
          (summary.failed > 0 ? `, ${summary.failed} com falha` : '') +
          (summary.unmapped.length > 0
            ? `. Sem mapeamento: ${summary.unmapped.join(', ')}`
            : ''),
      )
      await Promise.all([load(), loadDetails()])
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível sincronizar.')
    } finally {
      setSyncing(false)
    }
  }

  async function mapItem(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selected) return
    // O elemento precisa ser capturado ANTES do await: o React anula
    // event.currentTarget quando o handler síncrono termina, e chamar
    // .reset() depois lançaria TypeError — exibindo erro de falha em um
    // salvamento que deu certo.
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    setError(null)
    try {
      await apiFetch(`/integrations/${selected}/items`, {
        method: 'POST',
        body: JSON.stringify({
          externalItemId: String(form.get('externalItemId')),
          externalName: String(form.get('externalName') || '') || null,
          productId: String(form.get('productId') || '') || null,
        }),
      })
      formElement.reset()
      await loadDetails()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível mapear o item.')
    }
  }

  const unmappedCount = items.filter((item) => item.productId === null).length

  return (
    <section className="flex flex-col gap-8">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {message ? <p className="text-sm">{message}</p> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        {integrations.map((integration) => (
          <button
            key={integration.id}
            type="button"
            onClick={() => setSelected(integration.id)}
            className={`rounded-xl border-2 p-4 text-left ${
              selected === integration.id ? 'border-brand-600' : 'border-border'
            }`}
          >
            <div className="flex items-baseline justify-between">
              <span className="font-semibold">{CHANNEL_LABEL[integration.channel]}</span>
              <span
                className={`text-xs ${integration.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}
              >
                {STATUS_LABEL[integration.status]}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {integration.storeName ?? integration.externalStoreId ?? 'Loja não identificada'}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              {integration.isReceiving ? 'Recebendo pedidos' : 'Recebimento pausado'}
              {integration.autoAccept ? ' · aceite automático' : ''}
            </p>
            {integration.lastError ? (
              <p className="mt-1 text-xs text-destructive">{integration.lastError}</p>
            ) : null}
            {!integration.hasCredentials ? (
              <p className="mt-1 text-xs text-destructive">Sem credenciais configuradas</p>
            ) : null}
          </button>
        ))}
      </div>

      {current ? (
        <div className="flex flex-col gap-4 rounded-xl border border-border p-4">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="font-semibold">{CHANNEL_LABEL[current.channel]}</h2>
            <Button size="sm" variant="outline" onClick={() => void toggleReceiving(current)}>
              {current.isReceiving ? 'Pausar recebimento' : 'Retomar recebimento'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => void toggleAutoAccept(current)}>
              {current.autoAccept ? 'Desligar aceite automático' : 'Ligar aceite automático'}
            </Button>
            {current.channel === 'ifood' ? (
              <Button size="sm" onClick={() => void sync()} disabled={syncing}>
                {syncing ? 'Sincronizando…' : 'Sincronizar agora'}
              </Button>
            ) : null}
          </div>

          <p className="text-xs text-muted-foreground">{CHANNEL_DELIVERY_MODE[current.channel]}</p>
          {current.lastSyncAt ? (
            <p className="text-xs text-muted-foreground">
              Última sincronização: {new Date(current.lastSyncAt).toLocaleString('pt-BR')}
            </p>
          ) : null}
        </div>
      ) : null}

      {current ? (
        <div>
          <h2 className="mb-3 font-semibold">
            Mapeamento de cardápio
            {unmappedCount > 0 ? (
              <span className="ml-2 rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive">
                {unmappedCount} sem produto
              </span>
            ) : null}
          </h2>
          <p className="mb-3 text-xs text-muted-foreground">
            Item sem produto interno entra no pedido normalmente, mas não baixa estoque pela ficha
            técnica.
          </p>

          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum item mapeado ainda.</p>
          ) : (
            <ul className="mb-4 flex flex-col gap-1 text-sm">
              {items.map((item) => (
                <li key={item.id} className="flex justify-between gap-4 border-b border-border/60 py-1">
                  <span>
                    {item.externalName ?? item.externalItemId}
                    <span className="block text-xs text-muted-foreground">{item.externalItemId}</span>
                  </span>
                  <span className={item.productId ? '' : 'text-destructive'}>
                    {item.productId
                      ? (products.find((product) => product.id === item.productId)?.name ?? 'Produto')
                      : 'sem produto'}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <form onSubmit={mapItem} className="grid gap-3 sm:grid-cols-4">
            <Input name="externalItemId" placeholder="Código no parceiro" required />
            <Input name="externalName" placeholder="Nome no parceiro" />
            <select
              name="productId"
              className="h-10 rounded-lg border border-border bg-transparent px-3 text-sm"
            >
              <option value="">Sem produto interno</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
            </select>
            <Button type="submit">Mapear</Button>
          </form>
        </div>
      ) : null}

      {current && events.length > 0 ? (
        <div>
          <h2 className="mb-3 font-semibold">Últimos eventos</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {events.map((event) => (
              <li key={event.id} className="flex justify-between gap-4 border-b border-border/60 py-1">
                <span>
                  {new Date(event.createdAt).toLocaleString('pt-BR')} · {event.eventCode}
                  {event.externalOrderId ? ` · ${event.externalOrderId}` : ''}
                </span>
                <span className={event.error ? 'text-destructive' : 'text-muted-foreground'}>
                  {event.error ?? (event.processedAt ? 'processado' : 'pendente')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <form onSubmit={connect} className="flex flex-col gap-3 rounded-xl border border-border p-4">
        <h2 className="font-medium">Conectar canal</h2>
        <p className="text-xs text-muted-foreground">
          As credenciais são gravadas em uma tabela que só o servidor lê — o navegador nunca as
          recebe de volta.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <select
            name="channel"
            required
            className="h-10 rounded-lg border border-border bg-transparent px-3 text-sm"
          >
            <option value="ifood">iFood</option>
            <option value="ubereats">Uber Eats</option>
          </select>
          <Input name="externalStoreId" placeholder="ID da loja no parceiro" required />
          <Input name="storeName" placeholder="Nome da loja (opcional)" />
          <Input name="clientId" placeholder="Client ID" required />
          <Input name="clientSecret" type="password" placeholder="Client Secret" required />
          <Input name="webhookSecret" type="password" placeholder="Segredo do webhook (Uber Eats)" />
        </div>
        <Button type="submit">Conectar</Button>
      </form>
    </section>
  )
}
