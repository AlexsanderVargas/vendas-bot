import { randomInt } from 'node:crypto'

/**
 * Alfabeto sem os caracteres que se confundem quando a senha é anotada num
 * papel e digitada por outra pessoa: 0/O, 1/l/I. A senha temporária existe
 * justamente para esse trajeto — o gerente lê para o funcionário.
 */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

/** Doze caracteres deste alfabeto ≈ 59 bits; a senha vive poucos minutos. */
export const TEMP_PASSWORD_LENGTH = 12

/**
 * Contrato: (length?) -> string
 * `randomInt` (CSPRNG, sem viés de módulo) em vez de Math.random: senha
 * previsível de funcionário é porta aberta para o painel inteiro.
 */
export function generateTempPassword(length: number = TEMP_PASSWORD_LENGTH): string {
  let password = ''
  for (let index = 0; index < length; index += 1) {
    password += ALPHABET[randomInt(ALPHABET.length)]
  }
  return password
}
