/**
 * @jobforce/backend — Base del workspace para ficheros generados.
 *
 * Los `documents.file_path` son relativos a esta base (`jobforce/...`).
 * Quien genera los documentos (prepare.ts) y quien los lee (el ejecutor de
 * envíos, vía ExecutorDeps.workspaceBase) DEBEN resolver la misma base:
 *  - En local/tests: `~/workspace` (el workspace del usuario).
 *  - En el contenedor de Oracle: `/home/app/workspace`, donde el compose
 *    monta el volumen persistente `docsdata` sobre `jobforce/`.
 *
 * Se puede fijar con la variable de entorno `JOBFORCE_WORKSPACE_BASE`.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export function workspaceBase(): string {
  const env = process.env.JOBFORCE_WORKSPACE_BASE;
  if (env && env.trim() !== '') return env;
  return join(homedir(), 'workspace');
}
