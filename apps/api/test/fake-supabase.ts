import type { SupabaseClient } from '@supabase/supabase-js'

export type TableRows = Record<string, ReadonlyArray<Record<string, unknown>>>

/** Respostas de funções RPC, por nome. */
export type RpcHandlers = Record<string, (params: Record<string, unknown>) => unknown>

/** Registro do que foi escrito, para as asserções inspecionarem. */
export interface FakeWrites {
  inserted: { table: string; rows: Record<string, unknown>[] }[]
  updated: { table: string; patch: Record<string, unknown> }[]
  deleted: string[]
  /** Caminhos assinados para envio e removidos do bucket. */
  signed: string[]
  removed: string[]
  /** Contas criadas, alteradas e apagadas no Auth (Admin API). */
  authCreated?: { id: string; email: string; password?: string; appMetadata?: unknown }[]
  authUpdated?: { id: string; password?: string; appMetadata?: unknown }[]
  authDeleted?: string[]
  authInvited?: { email: string; redirectTo?: string }[]
}

interface Filter {
  column: string
  value: unknown
  op: 'eq' | 'in' | 'ilike'
}

/**
 * Cliente Supabase falso para testes: reproduz o encadeamento do PostgREST
 * (from/select/eq/in/order/maybeSingle) sobre linhas em memória, aplicando os
 * filtros de verdade. Serve para exercitar a lógica de montagem de payload
 * sem depender de rede.
 *
 * Contrato: (tables) -> SupabaseClient
 */
export function createFakeSupabase(
  tables: TableRows,
  rpcs: RpcHandlers = {},
  writes: FakeWrites = { inserted: [], updated: [], deleted: [], signed: [], removed: [] },
): SupabaseClient {
  return {
    from(table: string) {
      return new FakeQuery(tables[table] ?? [], table, writes)
    },
    storage: {
      from(bucket: string) {
        return {
          async createSignedUploadUrl(path: string) {
            writes.signed.push(path)
            return {
              data: { path, token: `token-${bucket}`, signedUrl: `https://storage/${bucket}/${path}` },
              error: null,
            }
          },
          async remove(paths: string[]) {
            writes.removed.push(...paths)
            return { data: paths.map((name) => ({ name })), error: null }
          },
        }
      },
    },
    /**
     * Admin API do Supabase Auth. Só o suficiente para as rotas de equipe:
     * criar acesso, trocar senha, desfazer criação e convidar por e-mail.
     */
    auth: {
      admin: {
        async createUser(attributes: {
          email: string
          password?: string
          app_metadata?: unknown
        }) {
          const created = (writes.authCreated ??= [])
          const id = `a0000000-0000-0000-0000-${String(created.length + 1).padStart(12, '0')}`
          created.push({
            id,
            email: attributes.email,
            ...(attributes.password ? { password: attributes.password } : {}),
            appMetadata: attributes.app_metadata,
          })
          return { data: { user: { id, email: attributes.email } }, error: null }
        },
        async updateUserById(id: string, attributes: { password?: string; app_metadata?: unknown }) {
          ;(writes.authUpdated ??= []).push({
            id,
            ...(attributes.password ? { password: attributes.password } : {}),
            appMetadata: attributes.app_metadata,
          })
          return { data: { user: { id } }, error: null }
        },
        async deleteUser(id: string) {
          ;(writes.authDeleted ??= []).push(id)
          return { data: null, error: null }
        },
        async inviteUserByEmail(email: string, options?: { redirectTo?: string }) {
          const invited = (writes.authInvited ??= [])
          invited.push({ email, ...(options?.redirectTo ? { redirectTo: options.redirectTo } : {}) })
          const id = `b0000000-0000-0000-0000-${String(invited.length).padStart(12, '0')}`
          return { data: { user: { id, email } }, error: null }
        },
      },
    },
    async rpc(name: string, params: Record<string, unknown>) {
      const handler = rpcs[name]
      if (!handler) return { data: null, error: { message: `RPC não configurada: ${name}` } }
      return { data: handler(params), error: null }
    },
  } as unknown as SupabaseClient
}

class FakeQuery implements PromiseLike<{ data: unknown; error: null }> {
  private filters: Filter[] = []
  private orderBy: string | null = null
  private upserted: unknown[] | null = null
  private limitTo: number | null = null
  private rangeFrom = 0
  private rangeTo: number | null = null
  private countMode = false
  private headOnly = false

  constructor(
    private readonly rows: ReadonlyArray<Record<string, unknown>>,
    private readonly table = 'desconhecida',
    private readonly writes: FakeWrites | null = null,
  ) {}

  /**
   * Aceita a forma `select(colunas, { count: 'exact', head: true })` do
   * supabase-js: nesse modo a resposta traz `count` e nenhuma linha.
   */
  select(_columns?: string, options?: { count?: string; head?: boolean }): this {
    if (options?.count) this.countMode = true
    if (options?.head) this.headOnly = true
    return this
  }

  eq(column: string, value: unknown): this {
    this.filters.push({ column, value, op: 'eq' })
    return this
  }

  in(column: string, values: readonly unknown[]): this {
    this.filters.push({ column, value: values, op: 'in' })
    return this
  }

  ilike(column: string, pattern: string): this {
    this.filters.push({ column, value: pattern, op: 'ilike' })
    return this
  }

  order(column: string): this {
    this.orderBy = column
    return this
  }

  insert(rows?: unknown): this {
    if (this.writes && rows !== undefined) {
      this.writes.inserted.push({
        table: this.table,
        rows: (Array.isArray(rows) ? rows : [rows]) as Record<string, unknown>[],
      })
    }
    return this
  }

  upsert(rows: unknown): this {
    this.upserted = Array.isArray(rows) ? rows : [rows]
    return this
  }

  not(): this {
    return this
  }

  limit(count: number): this {
    this.limitTo = count
    return this
  }

  range(from: number, to: number): this {
    this.rangeFrom = from
    this.rangeTo = to
    return this
  }

  update(patch?: unknown): this {
    if (this.writes && patch !== undefined) {
      this.writes.updated.push({ table: this.table, patch: patch as Record<string, unknown> })
    }
    return this
  }

  delete(): this {
    if (this.writes) this.writes.deleted.push(this.table)
    return this
  }

  async single(): Promise<{ data: Record<string, unknown> | null; error: null }> {
    const upserted = this.upserted?.[0] as Record<string, unknown> | undefined
    return { data: upserted ?? this.resolve()[0] ?? null, error: null }
  }

  private resolve(): Record<string, unknown>[] {
    let result = this.rows.filter((row) =>
      this.filters.every((filter) => {
        if (filter.op === 'eq') return row[filter.column] === filter.value
        if (filter.op === 'in') return (filter.value as unknown[]).includes(row[filter.column])
        const pattern = String(filter.value).replace(/%/g, '').toLowerCase()
        return String(row[filter.column] ?? '').toLowerCase().includes(pattern)
      }),
    )
    if (this.orderBy) {
      const key = this.orderBy
      result = [...result].sort((a, b) => Number(a[key] ?? 0) - Number(b[key] ?? 0))
    }
    if (this.rangeTo !== null) {
      result = result.slice(this.rangeFrom, this.rangeTo + 1)
    }
    if (this.limitTo !== null) {
      result = result.slice(0, this.limitTo)
    }
    return result as Record<string, unknown>[]
  }

  async maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: null }> {
    return { data: this.resolve()[0] ?? null, error: null }
  }

  then<TResult1 = { data: unknown; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    const rows = this.resolve()
    const payload = {
      data: this.headOnly ? null : rows,
      error: null,
      ...(this.countMode ? { count: rows.length } : {}),
    }
    return Promise.resolve(payload as { data: unknown; error: null }).then(onfulfilled)
  }
}
