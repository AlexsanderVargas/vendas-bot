'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { apiFetch, ApiError } from '@/lib/api'

interface Permission {
  key: string
  module: string
  label: string
  description: string | null
}

interface Role {
  id: string
  key: string
  name: string
  permissions: Record<string, boolean>
  isSystem: boolean
}

interface StaffMember {
  id: string
  name: string
  phone: string | null
  isActive: boolean
  roleId: string
  roleName: string | null
}

export function StaffManager() {
  const [permissions, setPermissions] = useState<Permission[]>([])
  const [roles, setRoles] = useState<Role[]>([])
  const [staff, setStaff] = useState<StaffMember[]>([])
  const [selectedRole, setSelectedRole] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [permissionList, roleList, staffList] = await Promise.all([
        apiFetch<Permission[]>('/permissions'),
        apiFetch<Role[]>('/roles'),
        apiFetch<StaffMember[]>('/staff'),
      ])
      setPermissions(permissionList)
      setRoles(roleList)
      setStaff(staffList)
      setSelectedRole((current) => current || roleList[0]?.id || '')
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível carregar a equipe.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const role = roles.find((candidate) => candidate.id === selectedRole)
  const modules = [...new Set(permissions.map((permission) => permission.module))]

  /** Reproduz a resolução do servidor: negação vence, depois exata, depois curingas. */
  function grants(permissionsMap: Record<string, boolean>, key: string): boolean {
    if (permissionsMap[key] === false) return false
    if (permissionsMap[key] === true) return true
    const parts = key.split('.')
    for (let index = parts.length - 1; index > 0; index -= 1) {
      const wildcard = `${parts.slice(0, index).join('.')}.*`
      if (permissionsMap[wildcard] === false) return false
      if (permissionsMap[wildcard] === true) return true
    }
    return permissionsMap['*'] === true
  }

  async function invite(event: React.FormEvent<HTMLFormElement>) {
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
      await apiFetch('/staff/invite', {
        method: 'POST',
        body: JSON.stringify({
          email: String(form.get('email')),
          name: String(form.get('name')),
          roleId: String(form.get('roleId')),
          phone: String(form.get('phone') || '') || null,
        }),
      })
      setMessage('Convite enviado por e-mail.')
      formElement.reset()
      await load()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível enviar o convite.')
    }
  }

  async function toggleActive(member: StaffMember) {
    setError(null)
    try {
      await apiFetch(`/staff/${member.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !member.isActive }),
      })
      await load()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível atualizar o funcionário.')
    }
  }

  async function changeRole(member: StaffMember, roleId: string) {
    setError(null)
    try {
      await apiFetch(`/staff/${member.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ roleId }),
      })
      await load()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Não foi possível mudar o papel.')
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

      <div>
        <h2 className="mb-3 font-semibold">Funcionários</h2>
        {staff.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum funcionário cadastrado.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {staff.map((member) => (
              <li
                key={member.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4 text-sm"
              >
                <span>
                  <strong>{member.name}</strong>
                  {!member.isActive ? (
                    <span className="ml-2 text-xs text-destructive">inativo</span>
                  ) : null}
                  {member.phone ? (
                    <span className="block text-muted-foreground">{member.phone}</span>
                  ) : null}
                </span>
                <span className="flex items-center gap-2">
                  <select
                    value={member.roleId}
                    onChange={(event) => void changeRole(member, event.target.value)}
                    className="h-9 rounded-lg border border-border bg-transparent px-2 text-sm"
                  >
                    {roles.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.name}
                      </option>
                    ))}
                  </select>
                  <Button variant="outline" size="sm" onClick={() => void toggleActive(member)}>
                    {member.isActive ? 'Desativar' : 'Reativar'}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <form onSubmit={invite} className="flex flex-col gap-3 rounded-xl border border-border p-4">
        <h2 className="font-medium">Convidar funcionário</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input name="name" placeholder="Nome" required />
          <Input name="email" type="email" placeholder="E-mail" required />
          <Input name="phone" placeholder="Telefone" />
          <select
            name="roleId"
            required
            className="h-10 rounded-lg border border-border bg-transparent px-3 text-sm"
          >
            {roles.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit">Enviar convite</Button>
      </form>

      <div>
        <h2 className="mb-3 font-semibold">Permissões por papel</h2>
        <label className="mb-4 flex max-w-xs flex-col gap-1.5 text-sm font-medium">
          Papel
          <select
            value={selectedRole}
            onChange={(event) => setSelectedRole(event.target.value)}
            className="h-10 rounded-lg border border-border bg-transparent px-3 text-sm"
          >
            {roles.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name} {option.isSystem ? '(sistema)' : ''}
              </option>
            ))}
          </select>
        </label>

        {role ? (
          <div className="flex flex-col gap-4">
            {modules.map((module) => (
              <div key={module}>
                <h3 className="mb-2 text-sm font-medium">{module}</h3>
                <ul className="grid gap-1 sm:grid-cols-2">
                  {permissions
                    .filter((permission) => permission.module === module)
                    .map((permission) => {
                      const allowed = grants(role.permissions, permission.key)
                      return (
                        <li key={permission.key} className="flex items-center gap-2 text-sm">
                          <span aria-hidden className={allowed ? 'text-brand-600' : 'text-muted-foreground'}>
                            {allowed ? '●' : '○'}
                          </span>
                          <span className={allowed ? '' : 'text-muted-foreground'}>
                            {permission.label}
                          </span>
                        </li>
                      )
                    })}
                </ul>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  )
}
