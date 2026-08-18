'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { createClient } from '@/lib/supabase/client'
import { apiFetch, ApiError } from '@/lib/api'

type TableStatus = 'free' | 'occupied' | 'billing' | 'cleaning' | 'reserved' | 'inactive'

interface DiningTable {
  id: string
  label: string
  seats: number
  status: TableStatus
  sectorId: string | null
  sectorName: string | null
}

interface Sector {
  id: string
  name: string
}

const STATUS_LABEL: Record<TableStatus, string> = {
  free: 'Livre',
  occupied: 'Ocupada',
  billing: 'Fechando conta',
  cleaning: 'Aguardando limpeza',
  reserved: 'Reservada',
  inactive: 'Fora de uso',
}

const STATUS_STYLE: Record<TableStatus, string> = {
  free: 'border-border',
  occupied: 'border-brand-600 bg-brand-50/40',
  billing: 'border-amber-500',
  cleaning: 'border-sky-500',
  reserved: 'border-violet-500',
  inactive: 'border-border opacity-50',
}

/** Próximos status permitidos — espelha can_transition_table do banco. */
const NEXT_STATUS: Record<TableStatus, TableStatus[]> = {
  free: ['occupied', 'reserved', 'cleaning'],
  reserved: ['occupied', 'free'],
  occupied: ['billing', 'cleaning'],
  billing: ['cleaning', 'occupied'],
  cleaning: ['free'],
  inactive: ['free'],
}

export function FloorMap() {
  const [tables, setTables] = useState<DiningTable[]>([])
  const [sectors, setSectors] = useState<Sector[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [tableList, sectorList] = await Promise.all([
        apiFetch<DiningTable[]>('/dining/tables'),
        apiFetch<Sector[]>('/dining/sectors'),
      ])
      setTables(tableList)
      setSectors(sectorList)
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível carregar o salão.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // O mapa reflete o que outros garçons fazem, sem refresh.
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel('salao')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'dining_tables' },
        (payload) => {
          const row = payload.new as Record<string, unknown>
          setTables((current) =>
            current.map((table) =>
              table.id === row.id ? { ...table, status: row.status as TableStatus } : table,
            ),
          )
        },
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [])

  async function changeStatus(id: string, status: TableStatus) {
    setError(null)
    try {
      await apiFetch(`/dining/tables/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      })
      setTables((current) =>
        current.map((table) => (table.id === id ? { ...table, status } : table)),
      )
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível mudar o status.')
    }
  }

  async function addTable(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setError(null)
    try {
      await apiFetch('/dining/tables', {
        method: 'POST',
        body: JSON.stringify({
          label: String(form.get('label')),
          seats: Number(form.get('seats') || 4),
          sectorId: String(form.get('sectorId') || '') || null,
        }),
      })
      event.currentTarget.reset()
      await load()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível cadastrar a mesa.')
    }
  }

  const bySector = sectors.map((sector) => ({
    sector,
    tables: tables.filter((table) => table.sectorId === sector.id),
  }))
  const semSetor = tables.filter((table) => table.sectorId === null)

  return (
    <section className="flex flex-col gap-8">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {[...bySector, { sector: { id: 'sem-setor', name: 'Sem setor' }, tables: semSetor }]
        .filter((group) => group.tables.length > 0)
        .map((group) => (
          <div key={group.sector.id}>
            <h2 className="mb-3 font-semibold">{group.sector.name}</h2>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {group.tables.map((table) => (
                <li key={table.id} className={`rounded-xl border-2 p-4 ${STATUS_STYLE[table.status]}`}>
                  <div className="flex items-baseline justify-between">
                    <span className="text-lg font-semibold">{table.label}</span>
                    <span className="text-xs text-muted-foreground">{table.seats} lugares</span>
                  </div>
                  <p className="mt-1 text-sm">{STATUS_LABEL[table.status]}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {NEXT_STATUS[table.status].map((next) => (
                      <Button
                        key={next}
                        size="sm"
                        variant="outline"
                        onClick={() => void changeStatus(table.id, next)}
                      >
                        {STATUS_LABEL[next]}
                      </Button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}

      {tables.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhuma mesa cadastrada.</p>
      ) : null}

      <form onSubmit={addTable} className="flex flex-col gap-3 rounded-xl border border-border p-4">
        <h2 className="font-medium">Nova mesa</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Input name="label" placeholder="Identificação (M1)" required maxLength={20} />
          <Input name="seats" type="number" min="1" max="99" placeholder="Lugares" defaultValue={4} />
          <select
            name="sectorId"
            className="h-10 rounded-lg border border-border bg-transparent px-3 text-sm"
          >
            <option value="">Sem setor</option>
            {sectors.map((sector) => (
              <option key={sector.id} value={sector.id}>
                {sector.name}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit">Cadastrar mesa</Button>
      </form>
    </section>
  )
}
