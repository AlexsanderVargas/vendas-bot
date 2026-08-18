import { SignJWT } from 'jose'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'

const secret = () => new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET!)

export const TENANT_A = '10000000-0000-0000-0000-000000000001'
export const TENANT_B = '10000000-0000-0000-0000-000000000002'
export const STAFF_A = '00000000-0000-0000-0000-0000000000a1'
export const CUSTOMER_A = '00000000-0000-0000-0000-0000000000c1'

/** Contrato: (sub, appMetadata?) -> Promise<string> — JWT assinado como o Supabase Auth. */
export async function signToken(
  sub: string,
  appMetadata: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
): Promise<string> {
  return new SignJWT({ app_metadata: appMetadata, role: 'authenticated', ...overrides })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(secret())
}

export async function staffToken(tenantId = TENANT_A): Promise<string> {
  return signToken(STAFF_A, { tenant_id: tenantId })
}

export async function customerToken(): Promise<string> {
  return signToken(CUSTOMER_A, {})
}

export async function buildTestServer(): Promise<FastifyInstance> {
  return buildServer()
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}
