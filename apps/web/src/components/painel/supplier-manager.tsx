'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { apiFetch, ApiError } from '@/lib/api'

interface Supplier {
  id: string
  name: string
  document: string | null
  email: string | null
  phone: string | null
  contactName: string | null
  notes: string | null
  isActive: boolean
}

export function SupplierManager() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setSuppliers(await apiFetch<Supplier[]>('/suppliers'))
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível carregar os fornecedores.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setError(null)
    try {
      await apiFetch<Supplier>('/suppliers', {
        method: 'POST',
        body: JSON.stringify({
          name: String(form.get('name')),
          document: String(form.get('document') || '').replace(/\D/g, '') || null,
          email: String(form.get('email') || '') || null,
          phone: String(form.get('phone') || '') || null,
          contactName: String(form.get('contactName') || '') || null,
        }),
      })
      event.currentTarget.reset()
      await load()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível salvar o fornecedor.')
    }
  }

  return (
    <section className="flex flex-col gap-6">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : suppliers.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhum fornecedor cadastrado.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {suppliers.map((supplier) => (
            <li key={supplier.id} className="rounded-xl border border-border p-4 text-sm">
              <p className="font-medium">{supplier.name}</p>
              <p className="text-muted-foreground">
                {[supplier.document, supplier.contactName, supplier.phone, supplier.email]
                  .filter(Boolean)
                  .join(' · ') || 'Sem dados de contato'}
              </p>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-xl border border-border p-4">
        <h2 className="font-medium">Novo fornecedor</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input name="name" placeholder="Razão social" required />
          <Input name="document" placeholder="CNPJ ou CPF (só números)" />
          <Input name="contactName" placeholder="Contato" />
          <Input name="phone" placeholder="Telefone" />
          <Input name="email" type="email" placeholder="E-mail" className="sm:col-span-2" />
        </div>
        <Button type="submit">Cadastrar fornecedor</Button>
      </form>
    </section>
  )
}
