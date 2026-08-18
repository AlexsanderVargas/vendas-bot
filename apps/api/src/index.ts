import { buildServer } from './server.js'

const app = await buildServer()

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info(`${signal} recebido, encerrando`)
    await app.close()
    process.exit(0)
  })
}

try {
  await app.listen({ port: app.config.port, host: app.config.host })
} catch (error) {
  app.log.error({ err: error }, 'Falha ao iniciar o servidor')
  process.exit(1)
}
