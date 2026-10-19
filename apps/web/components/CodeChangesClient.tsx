'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '@/lib/auth';
import ConfirmModal from '@/components/ConfirmModal';
import type { Confirmacion } from '@/components/ConfirmModal';

type Estado = 'borrador' | 'en_desarrollo' | 'en_revision' | 'aprobada' | 'publicada' | 'revertida';
type Componente = 'frontend' | 'backend' | 'ambos';

interface Cambio {
  id: string;
  titulo: string;
  descripcion: string;
  rama: string | null;
  componente: Componente;
  estado: Estado;
  preview_url: string | null;
  test_estado: 'pendiente' | 'pasando' | 'fallando';
  test_detalle: Record<string, unknown>;
  aprobada_por: string | null;
  aprobada_en: string | null;
  declaracion_aprobacion: string | null;
  publicada_en: string | null;
  commit_publicado: string | null;
  revertida_en: string | null;
  commit_revertido: string | null;
  revert_estado: 'idle' | 'en_curso' | 'completada' | 'fallida';
  revert_resultado: Record<string, unknown>;
  revert_motivo: string | null;
  created_at: string;
  updated_at: string;
}

interface EventoAuditoria {
  id: string;
  accion: string;
  detalles: Record<string, unknown>;
  actor: string | null;
  creada_en: string;
}

interface Detalle extends Cambio {
  auditoria: EventoAuditoria[];
}

const ESTADO_LABEL: Record<Estado, string> = {
  borrador: 'Borrador',
  en_desarrollo: 'En desarrollo',
  en_revision: 'En revisión',
  aprobada: 'Aprobada',
  publicada: 'Publicada',
  revertida: 'Revertida',
};

const ESTADO_BADGE: Record<Estado, string> = {
  borrador: 'badge pending',
  en_desarrollo: 'badge pending',
  en_revision: 'badge pending',
  aprobada: 'badge active',
  publicada: 'badge active',
  revertida: 'badge danger',
};

const COMPONENTE_LABEL: Record<Componente, string> = {
  frontend: 'Frontal',
  backend: 'Backend',
  ambos: 'Ambos',
};

const SIGUIENTE: Partial<Record<Estado, Estado>> = {
  borrador: 'en_desarrollo',
  en_desarrollo: 'en_revision',
};

async function parseApiError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; mensaje?: string; detalles?: string[] };
    const base = body.mensaje ?? body.error ?? `Error ${res.status}`;
    return body.detalles?.length ? `${base}: ${body.detalles.join('; ')}` : base;
  } catch {
    return `Error ${res.status}`;
  }
}

function fmtFecha(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-ES');
}

/**
 * Frontal de cambios de código (fase 6.2): crear propuestas, seguir su
 * ciclo de vida, autorizar la publicación con declaración expresa,
 * registrar la publicación y revertir en un clic.
 *
 * Contrato: GET/POST /api/code-changes, GET/PATCH /api/code-changes/:id,
 * POST /api/code-changes/:id/approve|publish|revert.
 */
export default function CodeChangesClient() {
  const { mutatingHeaders } = useAuth();
  const [cambios, setCambios] = useState<Cambio[]>([]);
  const [detalle, setDetalle] = useState<Detalle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [accionMsg, setAccionMsg] = useState<string | null>(null);

  const cargarLista = useCallback(async () => {
    try {
      const res = await fetch('/api/code-changes', { cache: 'no-store' });
      if (!res.ok) throw new Error(await parseApiError(res));
      const data = (await res.json()) as { cambios: Cambio[] };
      setCambios(data.cambios);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar la lista.');
    } finally {
      setLoading(false);
    }
  }, []);

  const cargarDetalle = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/code-changes/${id}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(await parseApiError(res));
      setDetalle((await res.json()) as Detalle);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar el detalle.');
    }
  }, []);

  useEffect(() => {
    void cargarLista();
  }, [cargarLista]);

  async function mutar(
    etiqueta: string,
    fn: () => Promise<Response>,
    trasOk?: (id: string) => Promise<void>,
  ) {
    setBusy(etiqueta);
    setError(null);
    setAccionMsg(null);
    try {
      const res = await fn();
      if (!res.ok) throw new Error(await parseApiError(res));
      const body = (await res.json()) as { id?: string; revert_id?: string };
      setAccionMsg('Hecho.');
      await cargarLista();
      const id = body.id ?? detalle?.id;
      if (trasOk && id) await trasOk(id);
      else if (id) await cargarDetalle(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'La operación falló.');
    } finally {
      setBusy(null);
    }
  }

  // --- Nueva propuesta ---------------------------------------------------
  const [titulo, setTitulo] = useState('');
  const [descripcion, setDescripcion] = useState('');
  const [componente, setComponente] = useState<Componente>('frontend');

  async function onCrear(e: FormEvent) {
    e.preventDefault();
    await mutar('crear', () =>
      fetch('/api/code-changes', {
        method: 'POST',
        headers: mutatingHeaders(),
        body: JSON.stringify({ titulo, descripcion, componente }),
      }),
      async (id) => {
        setTitulo('');
        setDescripcion('');
        await cargarDetalle(id);
      },
    );
  }

  // --- Actualización del detalle -----------------------------------------
  const [rama, setRama] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const [testEstado, setTestEstado] = useState<'pendiente' | 'pasando' | 'fallando'>('pendiente');
  const [testDetalleRaw, setTestDetalleRaw] = useState('{}');
  const [declaracion, setDeclaracion] = useState('');
  const [commit, setCommit] = useState('');
  const [motivo, setMotivo] = useState('');
  const [confirmacion, setConfirmacion] = useState<Confirmacion | null>(null);

  useEffect(() => {
    if (detalle) {
      setRama(detalle.rama ?? '');
      setPreviewUrl(detalle.preview_url ?? '');
      setTestEstado(detalle.test_estado);
      setTestDetalleRaw(JSON.stringify(detalle.test_detalle ?? {}, null, 2));
      setDeclaracion('');
      setCommit('');
      setMotivo('');
    }
  }, [detalle]);

  async function onGuardarCampos(e: FormEvent) {
    e.preventDefault();
    if (!detalle) return;
    let testDetalle: Record<string, unknown> | undefined;
    try {
      testDetalle = JSON.parse(testDetalleRaw || '{}') as Record<string, unknown>;
    } catch {
      setError('test_detalle no es un JSON válido.');
      return;
    }
    await mutar('guardar', () =>
      fetch(`/api/code-changes/${detalle.id}`, {
        method: 'PATCH',
        headers: mutatingHeaders(),
        body: JSON.stringify({
          rama: rama.trim() || null,
          preview_url: previewUrl.trim() || null,
          test_estado: testEstado,
          test_detalle: testDetalle,
        }),
      }),
    );
  }

  async function onAvanzar() {
    if (!detalle) return;
    const siguiente = SIGUIENTE[detalle.estado];
    if (!siguiente) return;
    await mutar('avanzar', () =>
      fetch(`/api/code-changes/${detalle.id}`, {
        method: 'PATCH',
        headers: mutatingHeaders(),
        body: JSON.stringify({ estado: siguiente }),
      }),
    );
  }

  async function onAprobar(e: FormEvent) {
    e.preventDefault();
    if (!detalle) return;
    const texto = declaracion.trim();
    if (!texto) {
      setError('Escribe la declaración de autorización.');
      return;
    }
    const id = detalle.id;
    setConfirmacion({
      titulo: 'Autorizar publicación',
      cuerpo: (
        <>
          <p>Vas a autorizar la publicación de este cambio.</p>
          <p className="muted">Declaración que quedará firmada y auditada:</p>
          <blockquote className="declaracion">«{texto}»</blockquote>
        </>
      ),
      textoConfirmar: 'Autorizar',
      onConfirm: () =>
        mutar('aprobar', () =>
          fetch(`/api/code-changes/${id}/approve`, {
            method: 'POST',
            headers: mutatingHeaders(),
            body: JSON.stringify({ declaracion: texto }),
          }),
        ),
    });
  }

  async function onPublicar(e: FormEvent) {
    e.preventDefault();
    if (!detalle) return;
    const c = commit.trim();
    if (!c) {
      setError('Indica el commit publicado (el merge a main lo hace el agente).');
      return;
    }
    await mutar('publicar', () =>
      fetch(`/api/code-changes/${detalle.id}/publish`, {
        method: 'POST',
        headers: mutatingHeaders(),
        body: JSON.stringify({ commit: c }),
      }),
    );
  }

  async function onRevertir(e: FormEvent) {
    e.preventDefault();
    if (!detalle) return;
    const m = motivo.trim();
    if (!m) {
      setError('Indica el motivo de la reversión.');
      return;
    }
    const queHara =
      detalle.componente === 'backend'
        ? 'El backend volverá al último despliegue anterior (git checkout + reconstrucción con docker) en el servidor Oracle. La base de datos NO se toca.'
        : detalle.componente === 'frontend'
          ? 'El frontal se revertirá al despliegue de producción anterior de Vercel (paso manual de un clic en el dashboard, con instrucciones).'
          : 'El backend volverá al último despliegue anterior en Oracle (la base de datos NO se toca) y el frontal al despliegue de producción anterior de Vercel (paso manual en el dashboard).';
    const id = detalle.id;
    const titulo = detalle.titulo;
    setConfirmacion({
      titulo: 'Revertir cambio',
      cuerpo: (
        <>
          <p>
            Vas a revertir <strong>«{titulo}»</strong>.
          </p>
          <p className="muted">{queHara}</p>
          <p>
            Motivo: <strong>{m}</strong>
          </p>
        </>
      ),
      textoConfirmar: 'Revertir',
      onConfirm: () =>
        mutar(
          'revertir',
          () =>
            fetch(`/api/code-changes/${id}/revert`, {
              method: 'POST',
              headers: mutatingHeaders(),
              body: JSON.stringify({ motivo: m }),
            }),
      async (id) => {
        // El revert trabaja en segundo plano: sondea hasta que termine.
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const res = await fetch(`/api/code-changes/${id}`, { cache: 'no-store' });
          if (!res.ok) break;
          const d = (await res.json()) as Detalle;
          setDetalle(d);
          if (d.revert_estado !== 'en_curso') break;
        }
        await cargarLista();
        },
      ),
    });
  }

  if (loading) return <p className="muted">Cargando cambios…</p>;

  return (
    <div>
      {error && <p className="badge danger">{error}</p>}
      {accionMsg && <p className="badge active">{accionMsg}</p>}

      <section className="card" style={{ marginBottom: '1.5rem' }}>
        <h2>Nueva propuesta</h2>
        <form className="form" onSubmit={onCrear} style={{ maxWidth: '640px' }}>
          <label>
            Título
            <input value={titulo} onChange={(e) => setTitulo(e.target.value)} maxLength={120} required />
          </label>
          <label>
            Descripción
            <textarea
              value={descripcion}
              onChange={(e) => setDescripcion(e.target.value)}
              rows={4}
              maxLength={5000}
              required
            />
          </label>
          <label>
            Componente
            <select value={componente} onChange={(e) => setComponente(e.target.value as Componente)}>
              <option value="frontend">Frontal</option>
              <option value="backend">Backend</option>
              <option value="ambos">Ambos</option>
            </select>
          </label>
          <button className="btn" type="submit" disabled={busy === 'crear'}>
            {busy === 'crear' ? 'Creando…' : 'Crear propuesta'}
          </button>
        </form>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: '1.5rem' }}>
        <section>
          <h2>Propuestas ({cambios.length})</h2>
          {cambios.length === 0 && <p className="muted">Aún no hay propuestas.</p>}
          <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: '0.6rem' }}>
            {cambios.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => void cargarDetalle(c.id)}
                  className="card"
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    cursor: 'pointer',
                    border: detalle?.id === c.id ? '2px solid var(--primary)' : undefined,
                  }}
                >
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong>{c.titulo}</strong>
                  </div>
                  <div style={{ marginTop: '0.3rem', display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                    <span className={ESTADO_BADGE[c.estado]}>{ESTADO_LABEL[c.estado]}</span>
                    <span className="badge">{COMPONENTE_LABEL[c.componente]}</span>
                    {c.revert_estado === 'en_curso' && <span className="badge pending">Revirtiendo…</span>}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section>
          {!detalle && <p className="muted">Selecciona una propuesta para ver el detalle.</p>}
          {detalle && (
            <div className="card">
              <h2>{detalle.titulo}</h2>
              <p>{detalle.descripcion}</p>
              <dl className="fact">
                <dt>Estado</dt>
                <dd>
                  <span className={ESTADO_BADGE[detalle.estado]}>{ESTADO_LABEL[detalle.estado]}</span>
                </dd>
                <dt>Componente</dt>
                <dd>{COMPONENTE_LABEL[detalle.componente]}</dd>
                <dt>Rama</dt>
                <dd>{detalle.rama ?? '—'}</dd>
                <dt>Vista previa</dt>
                <dd>
                  {detalle.preview_url ? (
                    <a href={detalle.preview_url} target="_blank" rel="noreferrer">
                      {detalle.preview_url}
                    </a>
                  ) : (
                    '—'
                  )}
                </dd>
                <dt>Tests</dt>
                <dd>
                  <span
                    className={
                      detalle.test_estado === 'pasando'
                        ? 'badge active'
                        : detalle.test_estado === 'fallando'
                          ? 'badge danger'
                          : 'badge pending'
                    }
                  >
                    {detalle.test_estado}
                  </span>
                </dd>
                {detalle.aprobada_en && (
                  <>
                    <dt>Aprobada</dt>
                    <dd>
                      {fmtFecha(detalle.aprobada_en)}
                      {detalle.declaracion_aprobacion && (
                        <>
                          <br />«{detalle.declaracion_aprobacion}»
                        </>
                      )}
                    </dd>
                  </>
                )}
                {detalle.publicada_en && (
                  <>
                    <dt>Publicada</dt>
                    <dd>
                      {fmtFecha(detalle.publicada_en)} · commit {detalle.commit_publicado}
                    </dd>
                  </>
                )}
                {detalle.revert_motivo && (
                  <>
                    <dt>Reversión</dt>
                    <dd>
                      {fmtFecha(detalle.revertida_en)} · {detalle.revert_estado} · {detalle.revert_motivo}
                      {detalle.commit_revertido && (
                        <>
                          <br />
                          Restaurado: {detalle.commit_revertido}
                        </>
                      )}
                    </dd>
                  </>
                )}
              </dl>

              {detalle.revert_estado === 'en_curso' && (
                <p className="badge pending">Reversión en curso… se actualiza solo.</p>
              )}

              {(detalle.estado === 'borrador' || detalle.estado === 'en_desarrollo') && (
                <>
                  <h3>Seguimiento</h3>
                  <form className="form" onSubmit={onGuardarCampos} style={{ maxWidth: '560px' }}>
                    <label>
                      Rama
                      <input value={rama} onChange={(e) => setRama(e.target.value)} placeholder="cambio/<id>-<slug>" />
                    </label>
                    <label>
                      URL de vista previa
                      <input value={previewUrl} onChange={(e) => setPreviewUrl(e.target.value)} />
                    </label>
                    <label>
                      Estado de tests
                      <select value={testEstado} onChange={(e) => setTestEstado(e.target.value as typeof testEstado)}>
                        <option value="pendiente">Pendiente</option>
                        <option value="pasando">Pasando</option>
                        <option value="fallando">Fallando</option>
                      </select>
                    </label>
                    <label>
                      Detalle de tests (JSON)
                      <textarea value={testDetalleRaw} onChange={(e) => setTestDetalleRaw(e.target.value)} rows={3} />
                    </label>
                    <button className="btn btn-small" type="submit" disabled={busy === 'guardar'}>
                      {busy === 'guardar' ? 'Guardando…' : 'Guardar'}
                    </button>
                  </form>
                  {SIGUIENTE[detalle.estado] && (
                    <p style={{ marginTop: '0.8rem' }}>
                      <button className="btn btn-small" type="button" onClick={() => void onAvanzar()} disabled={busy === 'avanzar'}>
                        {busy === 'avanzar' ? 'Avanzando…' : `Avanzar a «${ESTADO_LABEL[SIGUIENTE[detalle.estado]!]}»`}
                      </button>
                    </p>
                  )}
                </>
              )}

              {detalle.estado === 'en_revision' && (
                <>
                  <h3>Aprobar publicación</h3>
                  <p className="muted">
                    La publicación exige tu autorización expresa. La declaración quedará firmada y auditada.
                  </p>
                  <form className="form" onSubmit={onAprobar} style={{ maxWidth: '560px' }}>
                    <label>
                      Declaración de autorización
                      <textarea
                        value={declaracion}
                        onChange={(e) => setDeclaracion(e.target.value)}
                        rows={3}
                        maxLength={500}
                        required
                        placeholder="p. ej. Autorizo la publicación de este cambio tras revisar la vista previa."
                      />
                    </label>
                    <button className="btn btn-small" type="submit" disabled={busy === 'aprobar'}>
                      {busy === 'aprobar' ? 'Aprobando…' : 'Aprobar publicación'}
                    </button>
                  </form>
                </>
              )}

              {detalle.estado === 'aprobada' && (
                <>
                  <h3>Publicar</h3>
                  <p className="muted">
                    El merge a main y el despliegue los ejecuta el agente; aquí se registra la publicación.
                  </p>
                  <form className="form" onSubmit={onPublicar} style={{ maxWidth: '560px' }}>
                    <label>
                      Commit publicado
                      <input value={commit} onChange={(e) => setCommit(e.target.value)} required placeholder="sha del commit en main" />
                    </label>
                    <button className="btn btn-small" type="submit" disabled={busy === 'publicar'}>
                      {busy === 'publicar' ? 'Publicando…' : 'Registrar publicación'}
                    </button>
                  </form>
                </>
              )}

              {detalle.estado === 'publicada' && (
                <>
                  <h3>Revertir</h3>
                  <p className="muted">
                    {detalle.componente === 'backend' || detalle.componente === 'ambos'
                      ? 'El backend volverá al último despliegue anterior en el servidor Oracle. La base de datos nunca se revierte. '
                      : ''}
                    {detalle.componente === 'frontend' || detalle.componente === 'ambos'
                      ? 'El frontal se revierte al despliegue de producción anterior de Vercel (paso manual de un clic en el dashboard, con instrucciones).'
                      : ''}
                  </p>
                  <form className="form" onSubmit={onRevertir} style={{ maxWidth: '560px' }}>
                    <label>
                      Motivo
                      <textarea
                        value={motivo}
                        onChange={(e) => setMotivo(e.target.value)}
                        rows={2}
                        maxLength={500}
                        required
                      />
                    </label>
                    <button className="btn btn-small" type="submit" disabled={busy === 'revertir'}>
                      {busy === 'revertir' ? 'Revirtiendo…' : 'Revertir'}
                    </button>
                  </form>
                </>
              )}

              <h3>Línea de tiempo (auditoría)</h3>
              {detalle.auditoria.length === 0 && <p className="muted">Sin eventos.</p>}
              <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: '0.4rem' }}>
                {detalle.auditoria.map((e) => (
                  <li key={e.id} className="muted" style={{ fontSize: '0.9rem' }}>
                    <strong>{e.accion}</strong> · {fmtFecha(e.creada_en)}
                    {e.actor ? ` · por ${e.actor}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </div>
      <ConfirmModal confirmacion={confirmacion} onClose={() => setConfirmacion(null)} />
    </div>
  );
}
