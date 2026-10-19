/**
 * @jobforce/backend — Cifrado de secretos en reposo.
 *
 * AES-256-GCM con clave de 32 bytes procedente de `SECRETS_ENCRYPTION_KEY`
 * (base64 o hexadecimal). Cada cifrado usa un nonce aleatorio de 12 bytes.
 *
 * Reglas:
 * - La clave solo vive en la variable de entorno; nunca se persiste, se
 *   loguea ni se devuelve en respuestas. `keyRef()` devuelve un
 *   identificador opaco para la columna `key_ref`.
 * - `encryptSecret`/`decryptSecret` lanzan `SecretCryptoError` si la clave
 *   falta o es inválida: las rutas lo traducen a 503 `cifrado_no_configurado`.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export class SecretCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretCryptoError';
  }
}

export interface EncryptedSecret {
  ciphertext: string;
  nonce: string;
  keyRef: string;
}

/** Referencia opaca de la clave (nunca el valor). */
export function keyRef(): string {
  return 'env:SECRETS_ENCRYPTION_KEY';
}

/**
 * Resuelve la clave de 32 bytes desde la variable de entorno.
 * Acepta base64 (44 caracteres) o hexadecimal (64 caracteres).
 */
export function resolveEncryptionKey(envValue: string | null | undefined): Buffer {
  if (!envValue || envValue.trim() === '') {
    throw new SecretCryptoError(
      'SECRETS_ENCRYPTION_KEY no está definida: el guardado de secretos está deshabilitado.',
    );
  }
  const raw = envValue.trim();
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    key = Buffer.from(raw, 'base64');
  }
  if (key.length !== 32) {
    throw new SecretCryptoError(
      'SECRETS_ENCRYPTION_KEY inválida: debe ser una clave de 32 bytes (base64 o hexadecimal).',
    );
  }
  return key;
}

/** Cifra un secreto; devuelve ciphertext + nonce en base64. */
export function encryptSecret(plaintext: string, key: Buffer): EncryptedSecret {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([authTag, ciphertext]).toString('base64'),
    nonce: nonce.toString('base64'),
    keyRef: keyRef(),
  };
}

/** Descifra un secreto cifrado con `encryptSecret`. */
export function decryptSecret(encrypted: Omit<EncryptedSecret, 'keyRef'>, key: Buffer): string {
  const nonce = Buffer.from(encrypted.nonce, 'base64');
  const combined = Buffer.from(encrypted.ciphertext, 'base64');
  if (nonce.length !== 12 || combined.length < 16) {
    throw new SecretCryptoError('secreto cifrado corrupto o con formato inválido.');
  }
  const authTag = combined.subarray(0, 16);
  const ciphertext = combined.subarray(16);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
