import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestServer } from './helpers.js'

describe('infra', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = await buildTestServer()
  })
  afterAll(async () => {
    await app.close()
  })

  it('GET /api/v1/health respeita o contrato de saída', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('ok')
    expect(typeof body.uptime).toBe('number')
    expect(new Date(body.timestamp).toString()).not.toBe('Invalid Date')
  })

  it('rota inexistente devolve ErrorResponse padronizado', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/nao-existe' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ statusCode: 404, error: 'Not Found' })
    expect(res.json().message).toContain('/api/v1/nao-existe')
  })

  it('CORS aceita origem permitida e recusa desconhecida', async () => {
    const allowed = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/health',
      headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'GET' },
    })
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000')

    const blocked = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/health',
      headers: { origin: 'https://invasor.com', 'access-control-request-method': 'GET' },
    })
    expect(blocked.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('aplica cabeçalhos de segurança do helmet', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })
})
