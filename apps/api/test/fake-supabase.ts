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

  constructor(
    private readonly rows: ReadonlyArray<Record<string, unknown>>,
    private readonly table = 'desconhecida',
    private readonly writes: FakeWrites | null = null,
  ) {}

  select(): this {
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
    return Promise.resolve({ data: this.resolve(), error: null }).then(onfulfilled)
  }
}
