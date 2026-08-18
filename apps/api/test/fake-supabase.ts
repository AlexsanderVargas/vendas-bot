import type { SupabaseClient } from '@supabase/supabase-js'

export type TableRows = Record<string, ReadonlyArray<Record<string, unknown>>>

/** Respostas de funções RPC, por nome. */
export type RpcHandlers = Record<string, (params: Record<string, unknown>) => unknown>

interface Filter {
  column: string
  value: unknown
  op: 'eq' | 'in'
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
): SupabaseClient {
  return {
    from(table: string) {
      return new FakeQuery(tables[table] ?? [])
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

  constructor(private readonly rows: ReadonlyArray<Record<string, unknown>>) {}

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

  order(column: string): this {
    this.orderBy = column
    return this
  }

  insert(): this {
    return this
  }

  update(): this {
    return this
  }

  delete(): this {
    return this
  }

  async single(): Promise<{ data: Record<string, unknown> | null; error: null }> {
    return { data: this.resolve()[0] ?? null, error: null }
  }

  private resolve(): Record<string, unknown>[] {
    let result = this.rows.filter((row) =>
      this.filters.every((filter) =>
        filter.op === 'eq'
          ? row[filter.column] === filter.value
          : (filter.value as unknown[]).includes(row[filter.column]),
      ),
    )
    if (this.orderBy) {
      const key = this.orderBy
      result = [...result].sort((a, b) => Number(a[key] ?? 0) - Number(b[key] ?? 0))
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
