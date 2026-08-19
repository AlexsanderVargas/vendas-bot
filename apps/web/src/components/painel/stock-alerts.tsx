'use client'

import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api'

interface StockAlert {
  kind: 'below_minimum' | 'expiring' | 'expired'
  ingredientId: string
  ingredientName: string
  baseUnit: string
  quantity: number
  threshold: number | null
  expiresAt: string | null
  batchCode: string | null
}

const KIND_LABEL: Record<StockAlert['kind'], string> = {
  below_minimum: 'Abaixo do mínimo',
  expiring: 'Vence em breve',
  expired: 'Vencido',
}

export function StockAlerts() {
  const [alerts, setAlerts] = useState<StockAlert[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void apiFetch<StockAlert[]>('/stock/alerts')
      .then((list) => {
        setAlerts(list)
        setError(null)
      })
      .catch(() => setError('Não foi possível carregar os alertas de estoque.'))
      .finally(() => setLoaded(true))
  }, [])

  if (!loaded) return <p className="text-sm text-muted-foreground">Carregando alertas…</p>

  // Falha na carga não pode virar "está tudo bem": afirmar que não há alerta
  // quando não se sabe é o pior resultado possível para perecível vencido.
  if (error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    )
  }

  if (alerts.length === 0) {
    return <p className="text-sm text-muted-foreground">Nenhum alerta de estoque no momento.</p>
  }

  return (
    <ul className="flex flex-col gap-2">
      {alerts.map((alert, index) => (
        <li
          key={`${alert.ingredientId}-${alert.batchCode ?? index}`}
          className="flex items-center justify-between gap-4 rounded-lg border border-border p-3 text-sm"
        >
          <span>
            <strong>{alert.ingredientName}</strong>
            <span className="ml-2 text-muted-foreground">
              {KIND_LABEL[alert.kind]}
              {alert.expiresAt ? ` · ${new Date(alert.expiresAt).toLocaleDateString('pt-BR')}` : ''}
              {alert.batchCode ? ` · lote ${alert.batchCode}` : ''}
            </span>
          </span>
          <span className={alert.kind === 'expired' ? 'text-destructive' : ''}>
            {alert.quantity} {alert.baseUnit}
            {alert.threshold !== null ? ` / mín. ${alert.threshold}` : ''}
          </span>
        </li>
      ))}
    </ul>
  )
}
