'use client';

/**
 * Sección de integración Gmail en /configuracion (Fase 5).
 *
 * Primer campo editable del panel: el par client_id/client_secret de Google
 * OAuth es de SOLO ESCRITURA — el backend nunca devuelve el secret en
 * lectura. Incluye el flujo de autorización (botón "Conectar con Google")
 * y la revocación.
 */
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '@/lib/auth';

interface GmailEstado {
  redirectUri: string;
  encryptionConfigured: boolean;
  client: { configured: boolean; clientId: string | null; fromPanel: boolean };
  secretConfigured: boolean;
  oauth: {
    connected: boolean;
    accountEmail: string | null;
    scope: string | null;
    obtainedAt: string | null;
    revokedAt: string | null;
  };
}

type Estado =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: GmailEstado };

async function parseApiError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; detalle?: string };
    if (body?.detalle) return `${body.error ?? 'error'}: ${body.detalle}`;
    if (body?.error) return body.error;
  } catch {
    /* cuerpo no JSON */
  }
  return `El servidor respondió ${res.status}`;
}

export default function GoogleOAuthSection() {
  const { mutatingHeaders } = useAuth();
  const [estado, setEstado] = useState<Estado>({ kind: 'loading' });
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/integraciones/gmail/estado', { cache: 'no-store' });
      if (res.status === 404) {
        setEstado({ kind: 'error', message: 'El backend aún no expone la integración Gmail (pendiente de despliegue).' });
        return;
      }
      if (!res.ok) throw new Error(await parseApiError(res));
      const data = (await res.json()) as GmailEstado;
      setEstado({ kind: 'ready', data });
    } catch (e) {
      setEstado({
        kind: 'error',
        message: e instanceof Error ? e.message : 'No se pudo conectar con el servidor.',
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setSaveMsg(null);
    setSaving(true);
    try {
      const res = await fetch('/api/integraciones/gmail/config', {
        method: 'POST',
        headers: mutatingHeaders(),
        body: JSON.stringify({ clientId: clientId.trim(), clientSecret: clientSecret.trim() }),
      });
      if (!res.ok) {
        const msg = await parseApiError(res);
        setSaveMsg({
          ok: false,
          text:
            res.status === 403
              ? 'Sesión sin token CSRF: vuelve a iniciar sesión y reintenta.'
              : msg,
        });
        return;
      }
      setClientId('');
      setClientSecret('');
      setSaveMsg({ ok: true, text: 'Credenciales guardadas cifradas. El secret nunca se muestra.' });
      await load();
    } catch {
      setSaveMsg({ ok: false, text: 'No se pudo conectar con el servidor.' });
    } finally {
      setSaving(false);
    }
  }

  async function onConnect() {
    setSaveMsg(null);
    try {
      const res = await fetch('/api/integraciones/gmail/autorizar', { cache: 'no-store' });
      if (!res.ok) throw new Error(await parseApiError(res));
      const { url } = (await res.json()) as { url: string };
      window.location.href = url;
    } catch (e) {
      setSaveMsg({
        ok: false,
        text: e instanceof Error ? e.message : 'No se pudo iniciar la autorización.',
      });
    }
  }

  async function onRevoke() {
    setSaveMsg(null);
    try {
      const res = await fetch('/api/integraciones/gmail/revocar', {
        method: 'POST',
        headers: mutatingHeaders(),
      });
      if (!res.ok) throw new Error(await parseApiError(res));
      setSaveMsg({ ok: true, text: 'Conexión con Gmail revocada.' });
      await load();
    } catch (e) {
      setSaveMsg({
        ok: false,
        text: e instanceof Error ? e.message : 'No se pudo revocar la conexión.',
      });
    }
  }

  async function copyRedirectUri(uri: string) {
    try {
      await navigator.clipboard.writeText(uri);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* portapapeles no disponible */
    }
  }

  if (estado.kind === 'loading') {
    return <p className="muted">Cargando integración Gmail…</p>;
  }
  if (estado.kind === 'error') {
    return <div className="error" role="alert">{estado.message}</div>;
  }

  const { data } = estado;

  return (
    <section style={{ marginTop: '2rem' }}>
      <h2>Gmail — conexión OAuth</h2>
      <p className="muted">
        Paso 1: añade la siguiente URI de redirección en Google Cloud Console
        (proyecto JOBFORCE → Credenciales → cliente «JOBFORCE backend» →
        URIs de redirección autorizados).
      </p>
      <p>
        <code>{data.redirectUri}</code>{' '}
        <button type="button" className="btn btn-small btn-ghost" onClick={() => void copyRedirectUri(data.redirectUri)}>
          {copied ? 'Copiada ✓' : 'Copiar'}
        </button>
      </p>

      <h3>Credenciales de Google (campo protegido)</h3>
      <p className="muted">
        Pega aquí el <code>client_id</code> y el <code>client_secret</code> del cliente
        «JOBFORCE backend». Se guardan cifrados y el secret <strong>nunca</strong> se
        muestra de vuelta. Queda registrado quién y cuándo los actualizó, sin valores.
      </p>
      {!data.encryptionConfigured && (
        <div className="error" role="alert">
          El backend no tiene configurada la clave de cifrado (SECRETS_ENCRYPTION_KEY):
          no se pueden guardar credenciales hasta que se configure en el servidor.
        </div>
      )}
      <form className="form" onSubmit={(e) => void onSave(e)}>
        <div className="field">
          <label htmlFor="google-client-id">Client ID</label>
          <input
            id="google-client-id"
            name="google-client-id"
            autoComplete="off"
            spellCheck={false}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder={data.client.configured ? '•••••••• (ya configurado)' : 'xxx.apps.googleusercontent.com'}
            disabled={!data.encryptionConfigured || saving}
          />
        </div>
        <div className="field">
          <label htmlFor="google-client-secret">Client secret</label>
          <input
            id="google-client-secret"
            name="google-client-secret"
            type="password"
            autoComplete="new-password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder="••••••••"
            disabled={!data.encryptionConfigured || saving}
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={!data.encryptionConfigured || saving}>
          {saving ? 'Guardando…' : 'Guardar credenciales'}
        </button>
      </form>
      {saveMsg && (
        <div className={saveMsg.ok ? 'notice' : 'error'} role="status" style={{ marginTop: '0.75rem' }}>
          {saveMsg.text}
        </div>
      )}

      <h3>Estado</h3>
      <ul>
        <li>
          Credenciales:{' '}
          {data.client.configured ? (
            <>configuradas {data.client.fromPanel ? '(desde este panel)' : '(desde el servidor)'}</>
          ) : (
            'no configuradas'
          )}
        </li>
        <li>
          Gmail:{' '}
          {data.oauth.connected ? (
            <>conectado{data.oauth.accountEmail ? ` (${data.oauth.accountEmail})` : ''}</>
          ) : (
            'no conectado'
          )}
        </li>
      </ul>
      <p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void onConnect()}
          disabled={!data.client.configured || data.oauth.connected}
        >
          Conectar con Google
        </button>{' '}
        {data.oauth.connected && (
          <button type="button" className="btn btn-danger" onClick={() => void onRevoke()}>
            Revocar conexión
          </button>
        )}
      </p>
    </section>
  );
}
