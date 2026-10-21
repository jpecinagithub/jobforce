/**
 * @jobforce/backend — Envío de candidaturas por Gmail (canal email).
 *
 * El token de Gmail guardado se autorizó originalmente SOLO para leer
 * (seguimiento). Enviar exige que el ámbito guardado incluya
 * `gmail.send`: eso solo ocurre si Jon reconecta Gmail tras la
 * ampliación del ámbito pedido en routes/gmail.ts. Este módulo:
 *
 * - `gmailSendCapable`: ¿hay token vigente cuyo scope incluya send?
 * - `sendGmailApplication`: refresca el access token con el refresh
 *   token cifrado y envía un correo con el CV y la carta adjuntos vía
 *   la API de Gmail (messages.send). Los secretos nunca salen de aquí.
 */

import { readFile } from 'node:fs/promises';
import type { AppConfig } from '@jobforce/config';
import { query } from '@jobforce/database';
import { decryptSecret, resolveEncryptionKey } from './secrets.js';

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

interface GmailTokenRow {
  refresh_token_ciphertext: string;
  refresh_token_nonce: string;
  account_email: string | null;
  scope: string | null;
  revoked_at: Date | null;
}

async function loadToken(): Promise<GmailTokenRow | null> {
  const rows = await query<GmailTokenRow>(
    `SELECT refresh_token_ciphertext, refresh_token_nonce, account_email, scope, revoked_at
       FROM gmail_tokens WHERE provider = 'google' LIMIT 1`,
  );
  return rows[0] ?? null;
}

/** ¿Se puede enviar por Gmail ahora mismo? (token vigente + scope send). */
export async function gmailSendCapable(): Promise<boolean> {
  const t = await loadToken();
  if (!t || t.revoked_at) return false;
  return (t.scope ?? '').split(/\s+/).includes(GMAIL_SEND_SCOPE);
}

async function readGoogleCreds(
  config: AppConfig,
): Promise<{ clientId: string; clientSecret: string } | null> {
  const rows = await query<{ clave: string; value_ciphertext: string; value_nonce: string }>(
    `SELECT clave, value_ciphertext, value_nonce FROM protected_settings
      WHERE clave IN ('google_client_id', 'google_client_secret')`,
  );
  const idRow = rows.find((r) => r.clave === 'google_client_id');
  const secretRow = rows.find((r) => r.clave === 'google_client_secret');
  if (idRow && secretRow) {
    const key = resolveEncryptionKey(config.secretsEncryptionKey);
    return {
      clientId: decryptSecret(
        { ciphertext: idRow.value_ciphertext, nonce: idRow.value_nonce },
        key,
      ),
      clientSecret: decryptSecret(
        { ciphertext: secretRow.value_ciphertext, nonce: secretRow.value_nonce },
        key,
      ),
    };
  }
  if (config.googleClientId && config.googleClientSecret) {
    return { clientId: config.googleClientId, clientSecret: config.googleClientSecret };
  }
  return null;
}

async function refreshAccessToken(config: AppConfig, refreshToken: string): Promise<string> {
  const creds = await readGoogleCreds(config);
  if (!creds) throw new Error('credenciales de Google no configuradas');
  const params = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    grant_type: 'refresh_token',
  });
  const res = await fetch(config.googleTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Google devolvió ${res.status} al refrescar el token`);
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error('Google no devolvió access_token');
  return data.access_token;
}

export interface GmailApplicationInput {
  to: string;
  subject: string;
  bodyText: string;
  /** Rutas absolutas de los PDF a adjuntar (CV, carta). */
  attachments: string[];
}

const base64Url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

/** Envía la candidatura por Gmail. Devuelve el id del mensaje enviado. */
export async function sendGmailApplication(
  config: AppConfig,
  input: GmailApplicationInput,
): Promise<{ messageId: string }> {
  const token = await loadToken();
  if (!token || token.revoked_at) throw new Error('Gmail no está conectado');
  if (!(token.scope ?? '').split(/\s+/).includes(GMAIL_SEND_SCOPE)) {
    throw new Error('el token de Gmail no incluye permiso de envío (gmail.send)');
  }
  const key = resolveEncryptionKey(config.secretsEncryptionKey);
  const refreshToken = decryptSecret(
    { ciphertext: token.refresh_token_ciphertext, nonce: token.refresh_token_nonce },
    key,
  );
  const accessToken = await refreshAccessToken(config, refreshToken);

  const boundary = `jf_${Date.now().toString(36)}`;
  const parts: string[] = [
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    input.bodyText,
  ];
  for (const path of input.attachments) {
    const data = await readFile(path);
    const name = path.split('/').pop() ?? 'document.pdf';
    parts.push(
      `--${boundary}`,
      `Content-Type: application/pdf; name="${name}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${name}"`,
      '',
      data.toString('base64'),
    );
  }
  parts.push(`--${boundary}--`, '');
  const raw = base64Url(Buffer.from(parts.join('\r\n'), 'utf8'));

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Gmail devolvió ${res.status} al enviar`);
  const data = (await res.json()) as { id?: string };
  return { messageId: data.id ?? '' };
}
