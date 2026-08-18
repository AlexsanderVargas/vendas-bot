import type { GeoPoint } from '../menu/types.js'

/**
 * Deep links de navegação para o modo retirada.
 * Contrato: (destination, label?) -> string
 */
export function googleMapsLink(destination: GeoPoint | string, label?: string): string {
  const query =
    typeof destination === 'string'
      ? destination
      : `${destination.latitude},${destination.longitude}`
  const url = new URL('https://www.google.com/maps/dir/')
  url.searchParams.set('api', '1')
  url.searchParams.set('destination', query)
  if (label && typeof destination !== 'string') url.searchParams.set('destination_place_id', '')
  return url.toString()
}

/** Contrato: (destination) -> string — o Waze só navega por coordenadas. */
export function wazeLink(destination: GeoPoint): string {
  return `https://waze.com/ul?ll=${destination.latitude}%2C${destination.longitude}&navigate=yes`
}

/**
 * Contrato: (from, to) -> number — distância em metros pela fórmula de
 * Haversine. Usada só para exibição no cliente ("você está a 1,2 km");
 * o cálculo que vale para cobrança é o do PostGIS, no servidor.
 */
export function haversineMeters(from: GeoPoint, to: GeoPoint): number {
  const R = 6_371_000
  const toRad = (degrees: number) => (degrees * Math.PI) / 180
  const dLat = toRad(to.latitude - from.latitude)
  const dLon = toRad(to.longitude - from.longitude)
  const lat1 = toRad(from.latitude)
  const lat2 = toRad(to.latitude)

  const a =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return Math.round(2 * R * Math.asin(Math.sqrt(a)))
}
