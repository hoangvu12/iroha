/**
 * Recoverable secret material at rest: encrypted with the installation master
 * key, never hashed, because Iroha must be able to use it again.
 */
export { createSecretCipher, SecretCipherError, type SecretCipher } from './secret-cipher.ts'
