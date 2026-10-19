'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { parseApiError } from '@/lib/autonomy';
import {
  dimensionLabel,
  scoreBadgeClass,
  VERDICT_LABELS,
  verdictBadgeClass,
} from '@/lib/review';
import type { ReviewQueueItem, BatchResponse } from '@/lib/review';

/**
 * Cola de revisión (Fase 6.1): candidaturas en `ready_for_review` con resumen
 * de encaje. Aprobar/Rechazar en un toque; rechazar pide un motivo inline.
 * Tras cada acción la tarjeta sale de la cola. Soporta acciones por lote
 * sobre la selección de casillas.
 */
export default function ReviewQueueClient() {
  const { mutatingHeaders } = useAuth();
  const [items, setItems] = useState<ReviewQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [batchReason, setBatchReason] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/review/queue', { cache: 'no-store' });
      if (!res.ok) throw new Error(await parseApiError(res));
      const body = (await res.json()) as { queue?: ReviewQueueItem[] };
      setItems(body.queue ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo conectar con el servidor.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function removeItems(ids: string[]) {
    const gone = new Set(ids);
    setItems((prev) => prev.filter((it) => !gone.has(it.id)));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of gone) next.delete(id);
      return next;
    });
  }

  async function approveOne(id: string) {
    setActionError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/applications/${encodeURIComponent(id)}/approve`, {
        method: 'POST',
        headers: mutatingHeaders(),
      });
      if (!res.ok) throw new Error(await parseApiError(res));
      removeItems([id]);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'No se pudo aprobar.');
    } finally {
      setBusy(false);
    }
  }

  async function rejectOne(id: string, reason: string) {
    setActionError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/applications/${encodeURIComponent(id)}/reject`, {
        method: 'POST',
        headers: mutatingHeaders(),
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) throw new Error(await parseApiError(res));
      removeItems([id]);
      setRejectingId(null);
      setRejectReason('');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'No se pudo rechazar.');
    } finally {
      setBusy(false);
    }
  }

  async function batch(action: 'approve' | 'reject') {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (action === 'reject' && batchReason.trim() === '') {
      setActionError('Para rechazar en lote escribe primero el motivo.');
      return;
    }
    setActionError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/applications/review-batch', {
        method: 'POST',
        headers: mutatingHeaders(),
        body: JSON.stringify({
          ids,
          action,
          ...(action === 'reject' ? { reason: batchReason.trim() } : {}),
        }),
      });
      if (!res.ok) throw new Error(await parseApiError(res));
      const body = (await res.json()) as BatchResponse;
      const okIds = body.items.filter((i) => i.ok).map((i) => i.id);
      removeItems(okIds);
      const failed = body.items.filter((i) => !i.ok);
      if (failed.length > 0) {
        setActionError(
          `No se pudo procesar ${failed.length} candidatura(s): ` +
            failed.map((f) => `${f.id.slice(0, 8)} (${f.error ?? 'error'})`).join(', '),
        );
      }
      setBatchReason('');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'No se pudo procesar el lote.');
    } finally {
      setBusy(false);
    }
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === items.length && items.length > 0) {
      setSelected(new Set());
    } else {
      setSelected(new Set(items.map((i) => i.id)));
    }
  }

  if (loading) return <p className="muted">Cargando cola de revisión…</p>;
  if (error) return <div className="error" role="alert">{error}</div>;

  return (
    <>
      {actionError && <div className="error" role="alert">{actionError}</div>}

      {items.length === 0 ? (
        <div className="notice">No hay candidaturas pendientes de revisión. Buen trabajo.</div>
      ) : (
        <>
          <div className="filters" style={{ gridTemplateColumns: 'auto 1fr auto auto auto' }}>
            <label className="field check" style={{ marginBottom: 0, display: 'flex', alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={selected.size === items.length && items.length > 0}
                onChange={toggleAll}
                aria-label="Seleccionar todas"
              />{' '}
              Todas
            </label>
            <input
              type="text"
              placeholder="Motivo (obligatorio para rechazar en lote)"
              value={batchReason}
              onChange={(e) => setBatchReason(e.target.value)}
              maxLength={500}
              aria-label="Motivo del rechazo en lote"
            />
            <button
              type="button"
              className="btn btn-small"
              disabled={busy || selected.size === 0}
              onClick={() => void batch('approve')}
            >
              Aprobar seleccionadas ({selected.size})
            </button>
            <button
              type="button"
              className="btn btn-small btn-danger"
              disabled={busy || selected.size === 0}
              onClick={() => void batch('reject')}
            >
              Rechazar seleccionadas ({selected.size})
            </button>
          </div>

          <div className="cards" style={{ gridTemplateColumns: '1fr' }}>
            {items.map((it) => (
              <article key={it.id} className="card">
                <div className="actions-row" style={{ justifyContent: 'flex-start' }}>
                  <input
                    type="checkbox"
                    checked={selected.has(it.id)}
                    onChange={() => toggleOne(it.id)}
                    aria-label={`Seleccionar ${it.offer.title ?? 'candidatura'}`}
                  />
                  <span className={scoreBadgeClass(it.score)}>
                    {it.score === null ? 'sin puntuación' : `${it.score} pts`}
                  </span>
                  <span className={verdictBadgeClass(it.mandatoryVerdict)}>
                    {VERDICT_LABELS[it.mandatoryVerdict] ?? it.mandatoryVerdict}
                  </span>
                  <strong>{it.offer.company ?? 'Empresa desconocida'}</strong>
                  <span className="muted">·</span>
                  <span>{it.offer.title ?? 'Puesto sin título'}</span>
                  {it.offer.url && (
                    <a href={it.offer.url} target="_blank" rel="noopener noreferrer">
                      Ver oferta
                    </a>
                  )}
                </div>

                <div style={{ marginTop: '0.6rem' }}>
                  <strong>Por qué encaja:</strong>
                  <ul style={{ margin: '0.35rem 0' }}>
                    {it.resumenEncaje.topDimensiones.map((d) => (
                      <li key={d.dimension}>
                        <strong>{dimensionLabel(d.dimension)}</strong> — {d.puntos} pts
                        {d.explicacion && <span className="muted"> · {d.explicacion}</span>}
                      </li>
                    ))}
                  </ul>
                  <p className="muted" style={{ margin: 0 }}>
                    Hechos verificados del perfil referenciados: {it.resumenEncaje.hechosVerificados}
                  </p>
                </div>

                <div className="actions-row" style={{ marginTop: '0.6rem' }}>
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={busy}
                    onClick={() => void approveOne(it.id)}
                  >
                    Aprobar
                  </button>
                  {rejectingId === it.id ? (
                    <>
                      <input
                        type="text"
                        placeholder="Motivo del rechazo (obligatorio)"
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        maxLength={500}
                        style={{ minWidth: '16rem' }}
                        aria-label="Motivo del rechazo"
                        autoFocus
                      />
                      <button
                        type="button"
                        className="btn btn-small btn-danger"
                        disabled={busy || rejectReason.trim() === ''}
                        onClick={() => void rejectOne(it.id, rejectReason.trim())}
                      >
                        Confirmar rechazo
                      </button>
                      <button
                        type="button"
                        className="btn btn-small btn-ghost"
                        disabled={busy}
                        onClick={() => {
                          setRejectingId(null);
                          setRejectReason('');
                        }}
                      >
                        Cancelar
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-small btn-danger"
                      disabled={busy}
                      onClick={() => {
                        setRejectingId(it.id);
                        setRejectReason('');
                      }}
                    >
                      Rechazar
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </>
  );
}
