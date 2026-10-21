/**
 * Siembra la cuenta de un portal con la contraseña elegida por Jon.
 * La contraseña llega SOLO por stdin (nunca por argv ni ficheros), se
 * cifra con establecerCuentaPortal (AES-256-GCM) y no se imprime.
 * Uso: node seed-portal-account.mjs <host> <email>  (password por stdin)
 */
import { readFileSync } from 'node:fs';
import { loadConfig } from '/app/packages/config/dist/index.js';

const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
if (!password) {
  console.error('sin contraseña en stdin');
  process.exit(1);
}
const [host, email] = process.argv.slice(2);
const config = loadConfig();
const { establecerCuentaPortal } = await import('/app/apps/backend/dist/portal-accounts.js');
const { closePool } = await import('/app/packages/database/dist/index.js');
await establecerCuentaPortal(config, host, email, password, null);
console.log(`cuenta guardada (cifrada) para ${host} / ${email}`);
await closePool();
process.exit(0);
