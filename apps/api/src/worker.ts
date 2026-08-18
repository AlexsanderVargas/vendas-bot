import { createClient } from '@supabase/supabase-js'
import { loadConfig } from './config.js'
import {
  runSyncCycle,
  SYNC_INTEGRATION_COLUMNS,
  SyncCycleError,
  type IntegrationRecord,
} from './modules/integrations/service.js'
import { runFiscalCycle } from './modules/fiscal/worker.js'

/**
 * Worker de operação — processo SEPARADO do servidor HTTP.
 *
 * Dois laços que a API não pode hospedar:
 *  * o iFood não chama a gente, é polling: alguém precisa perguntar por
 *    eventos novos a cada meio minuto;
 *  * a fila fiscal precisa de quem a consuma e transmita ao integrador.
 *
 * Por que fora da API: escalar o servidor HTTP para duas instâncias dobraria
 * as consultas ao iFood. Em produção, rode UMA instância deste processo.
 *
 * Cada laço é sequencial (`await tick(); await sleep()`), então dois ciclos
 * nunca se sobrepõem — um ciclo lento atrasa o próximo em vez de correr junto
 * com ele.
 */

const config = loadConfig()

const supabaseAdmin = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const log = {
  info: (details: unknown, message: string) =>
    console.log(JSON.stringify({ level: 'info', message, ...(details as object) })),
  warn: (details: unknown, message: string) =>
    console.warn(JSON.stringify({ level: 'warn', message, ...(details as object) })),
}

let running = true

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Contrato: (nome, intervaloSegundos, tick) -> Promise<void>
 * Laço que só encerra quando `running` vira falso. Erro em um ciclo é
 * registrado e o laço continua: o worker não pode morrer porque o parceiro
 * ficou fora do ar por um minuto.
 */
async function loop(name: string, intervalSeconds: number, tick: () => Promise<void>) {
  while (running) {
    try {
      await tick()
    } catch (error) {
      log.warn({ err: (error as Error).message, loop: name }, 'Ciclo falhou; seguindo')
    }
    // Fatiado para o desligamento não esperar o intervalo inteiro.
    for (let waited = 0; waited < intervalSeconds && running; waited += 1) {
      await sleep(1000)
    }
  }
}

/** Um ciclo de polling: todas as integrações de canal por consulta. */
async function syncMarketplaces() {
  const { data, error } = await supabaseAdmin
    .from('integrations')
    .select(SYNC_INTEGRATION_COLUMNS)
    .eq('channel', 'ifood')
    .eq('status', 'connected')
    .eq('is_receiving', true)

  if (error) throw new Error(`Falha ao listar integrações: ${error.message}`)

  for (const row of (data ?? []) as IntegrationRecord[]) {
    try {
      const summary = await runSyncCycle({ integration: row, supabaseAdmin, logger: log })
      if (summary.ingested > 0 || summary.failed > 0) {
        log.info({ integrationId: row.id, ...summary }, 'Ciclo de marketplace concluído')
      }
    } catch (error) {
      // Uma integração quebrada não pode impedir as outras de sincronizar —
      // o erro já foi gravado em last_error e aparece no painel do lojista.
      const reason = error instanceof SyncCycleError ? error.reason : 'erro'
      log.warn({ integrationId: row.id, reason }, 'Integração falhou neste ciclo')
    }
  }
}

async function emitFiscalDocuments() {
  const summary = await runFiscalCycle({ supabaseAdmin, logger: log })
  if (summary.claimed > 0) {
    log.info({ ...summary }, 'Ciclo fiscal concluído')
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'Sinal recebido, encerrando após o ciclo atual')
    running = false
  })
}

log.info(
  {
    marketplaceSeconds: config.marketplacePollSeconds,
    fiscalSeconds: config.fiscalPollSeconds,
  },
  'Worker iniciado',
)

await Promise.all([
  loop('marketplaces', config.marketplacePollSeconds, syncMarketplaces),
  loop('fiscal', config.fiscalPollSeconds, emitFiscalDocuments),
])

log.info({}, 'Worker encerrado')
