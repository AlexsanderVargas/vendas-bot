import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Contrato: (...classes) -> string — junta classes Tailwind resolvendo conflitos. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
