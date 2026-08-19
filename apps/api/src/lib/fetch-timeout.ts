/**
 * Prazo máximo para chamadas a serviços de terceiros.
 *
 * Sem isso, um socket pendurado no iFood, no Uber Eats ou no integrador fiscal
 * congela o laço do worker por tempo indeterminado — e como o laço é sequencial
 * de propósito (uma instância não pode duplicar o polling), o estabelecimento
 * que travou impede o polling de TODOS os outros. Documento fiscal já
 * reivindicado fica preso em `transmitting` até o resgate.
 *
 * 20s é folgado para uma API de pedidos e curto o bastante para não estourar o
 * intervalo de polling (30s, recomendação do próprio iFood).
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 20_000

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/**
 * Contrato: (fetchImpl, timeoutMs?) -> FetchLike
 * Devolve o mesmo fetch com prazo. Um `signal` já informado pelo chamador é
 * respeitado: nesse caso o controle do cancelamento é dele.
 */
export function withTimeout(fetchImpl: FetchLike, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS): FetchLike {
  return async (url, init) => {
    if (init?.signal) return fetchImpl(url, init)
    return fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  }
}
