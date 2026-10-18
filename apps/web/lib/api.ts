/**
 * Helpers de acceso al backend desde Server Components.
 *
 * Llaman al backend DIRECTAMENTE por BACKEND_URL (los rewrites de
 * next.config.ts solo aplican a peticiones del navegador). La cookie de
 * sesión de la petición entrante se reenvía para que el backend la vea.
 *
 * `cache: 'no-store'` + `export const dynamic = 'force-dynamic'` en las
 * páginas garantizan datos frescos en cada carga.
 */
import { cookies } from 'next/headers';

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://127.0.0.1:3001';

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string };

export async function apiGet<T>(path: string): Promise<ApiResult<T>> {
  const store = await cookies();
  const header = store.getAll().map((c) => `${c.name}=${c.value}`).join('; ');
  try {
    const res = await fetch(`${BACKEND_URL}${path}`, {
      cache: 'no-store',
      headers: header ? { Cookie: header } : {},
    });
    if (!res.ok) {
      let message = `El backend respondió ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body?.error) message = body.error;
      } catch {
        /* el cuerpo no es JSON; se usa el mensaje genérico */
      }
      return { ok: false, status: res.status, message };
    }
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch {
    return {
      ok: false,
      status: 0,
      message: 'No se pudo conectar con el backend (¿está arrancado en ' + BACKEND_URL + '?)',
    };
  }
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}
