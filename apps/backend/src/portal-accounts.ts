/**
 * @jobforce/backend — Cuentas en portales de empleo (iCIMS y similares).
 *
 * Cuando un portal exige cuenta para aplicar y Jon ha ordenado la
 * aplicación (regla `crearCuentasPortales` de su política en true +
 * autorización expresa en el chat, 2026-10-21), el ejecutor crea la
 * cuenta con su correo y una contraseña generada. La contraseña se
 * guarda CIFRADA (AES-256-GCM, mismo esquema que gmail_tokens) para
 * reutilizarla en futuras candidaturas del mismo portal; nunca se
 * registra en logs, auditorías ni mensajes.
 */

import { randomBytes } from 'node:crypto';
import type { AppConfig } from '@jobforce/config';
import { query } from '@jobforce/database';
import { auditEvent } from './audit.js';
import { decryptSecret, encryptSecret, resolveEncryptionKey } from './secrets.js';

/**
 * Host contra el que se guarda la cuenta iCIMS: el del propio portal.
 * La web pública puede ser un alias (verificado en vivo 2026-10-21:
 * careers.sightsavers.org aplica sobre careers-sightsavers.icims.com).
 */
export function hostCuentaIcims(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.endsWith('icims.com')) return h;
  if (h === 'careers.sightsavers.org') return 'careers-sightsavers.icims.com';
  return h;
}

export interface PortalAccount {
  host: string;
  email: string;
  password: string;
  /** true si la cuenta se acaba de crear (la fila es nueva). */
  creada: boolean;
}

interface PortalAccountRow {
  password_ciphertext: string;
  password_nonce: string;
}

/** Contraseña fuerte generada (sin caracteres ambiguos para teclearla). */
export function generarPasswordPortal(): string {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(24);
  let core = '';
  for (let i = 0; i < 20; i++) core += alfabeto[bytes[i] % alfabeto.length];
  return `${core}9!x`;
}

/**
 * Devuelve la cuenta del portal (host) para el correo dado: la
 * existente (descifrada) o una nueva con contraseña generada,
 * persistida cifrada. La creación queda auditada SIN la contraseña.
 */
export async function obtenerOCrearCuentaPortal(
  config: AppConfig,
  host: string,
  email: string,
  actorId: string | null,
): Promise<PortalAccount> {
  const hostNorm = host.trim().toLowerCase();
  const existing = await query<PortalAccountRow>(
    `SELECT password_ciphertext, password_nonce FROM portal_accounts
      WHERE portal = $1 AND username = $2 LIMIT 1`,
    [hostNorm, email],
  );
  const key = resolveEncryptionKey(config.secretsEncryptionKey);
  if (existing.length > 0) {
    await query(
      `UPDATE portal_accounts SET last_used_at = now() WHERE portal = $1 AND username = $2`,
      [hostNorm, email],
    );
    return {
      host: hostNorm,
      email,
      password: decryptSecret(
        { ciphertext: existing[0].password_ciphertext, nonce: existing[0].password_nonce },
        key,
      ),
      creada: false,
    };
  }
  const password = generarPasswordPortal();
  const enc = encryptSecret(password, key);
  await query(
    `INSERT INTO portal_accounts
       (portal, username, password_ciphertext, password_nonce, key_ref, last_used_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (portal, username) DO NOTHING`,
    [hostNorm, email, enc.ciphertext, enc.nonce, enc.keyRef],
  );
  await auditEvent({
    actorId,
    action: 'portal_account_created',
    entityType: 'portal_account',
    entityId: null,
    details: { host: hostNorm, email },
  });
  return { host: hostNorm, email, password, creada: true };
}
