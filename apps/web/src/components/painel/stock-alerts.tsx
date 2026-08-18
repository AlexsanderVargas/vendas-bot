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

  useEffect(() => {
    void apiFetch<StockAlert[]>('/stock/alerts')
      .then(setAlerts)
      .catch(() => setAlerts([]))
      .finally(() => setLoaded(true))
  }, [])

  if (!loaded) return <p className="text-sm text-muted-foreground">Carregando alertas…</p>
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
