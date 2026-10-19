'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode, SyntheticEvent } from 'react';
import { useAuth } from '@/lib/auth';
import {
  parseApiError,
  KIND_LABELS,
  INTERVENTION_STATUS_LABELS,
} from '@/lib/autonomy';
import type { Intervention } from '@/lib/autonomy';

const INTERVENTIONS_ENDPOINTS_MSG =
  'El backend aún no expone el endpoint de intervenciones (pendiente del worker 2, contrato de fase 4). ' +
  'La bandeja aparecerá aquí cuando el backend esté listo.';

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind.replaceAll('_', ' ');
}

function statusBadgeClass(status: string): string {
  if (status === 'pendiente') return 'badge pending';
  if (status === 'resuelta') return 'badge active';
  if (status === 'descartada') return 'badge';
  return 'badge';
}

function formatDate(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString('es-ES');
}

function renderContext(context: unknown): ReactNode {
  if (context == null) return <span className="muted">Sin contexto</span>;
  if (typeof context === 'string') return <span>{context}</span>;
  if (typeof context === 'object') {
    const obj = context as Record<string, unknown>;
    const scalars = Object.entries(obj).filter(
      ([, v]) => v == null || ['string', 'number', 'boolean'].includes(typeof v),
    );
    const complex = Object.entries(obj).filter(
      ([, v]) => !['string', 'number', 'boolean'].includes(typeof v) && v != null,
    );
    return (
      <div>
        {scalars.map(([k, v]) => (
          <div key={k}>
            <strong>{k}:</strong> {String(v)}
          </div>
        ))}
        {complex.length > 0 && (
          <details>
            <summary className="muted">Ver detalles</summary>
            <pre className="json">{JSON.stringify(Object.fromEntries(complex), null, 2)}</pre>
          </details>
        )}
      </div>
    );
  }
  return <span>{String(context)}</span>;
}

/**
 * Bandeja de intervención (fase 4): tareas del motor que requieren atención
 * humana. Resolver o descartar con nota (POST /api/interventions/:id/resolve).
 * Si el endpoint aún no existe, la bandeja lo indica en vez de inventar datos.
 */
export default function InterventionsClient() {
  const { mutatingHeaders } = useAuth();
  const [items, setItems] = useState<Intervention[]>([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState('');
  const [filterKind, setFilterKind] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filterStatus) params.set('status', filterStatus);
      if (filterKind) params.set('kind', filterKind);
      const qs = params.toString();
      const res = await fetch(`/api/interventions${qs ? `?${qs}` : ''}`, { cache: 'no-store' });
      if (res.status === 404) {
        setUnavailable(true);
        setLoading(false);
        return;
      }
      if (!res.ok) throw new Error(await parseApiError(res));
      const body = (await res.json()) as { interventions?: Intervention[] } | Intervention[];
      const list = Array.isArray(body) ? body : (body.interventions ?? []);
      setItems(list);
      setUnavailable(false);
      setLoading(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo conectar con el servidor.');
      setLoading(false);
    }
  }, [filterStatus, filterKind]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onResolve(e: SyntheticEvent, id: string, resolution: 'resuelta' | 'descartada') {
    e.preventDefault();
    setResolveError(null);
    setBusyId(id);
    try {
      const res = await fetch(`/api/interventions/${encodeURIComponent(id)}/resolve`, {
        method: 'POST',
        headers: mutatingHeaders(),
        body: JSON.stringify({ resolution, note: notes[id]?.trim() || undefined }),
      });
      if (!res.ok) {
        setResolveError(await parseApiError(res));
        return;
      }
      await load();
    } catch {
      setResolveError('No se pudo conectar con el servidor.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      {loading ? (
        <p className="muted">Cargando bandeja de intervención…</p>
      ) : unavailable ? (
        <div className="notice" role="status">{INTERVENTIONS_ENDPOINTS_MSG}</div>
      ) : error ? (
        <div className="error" role="alert">{error}</div>
      ) : (
        <>
          <div className="filters">
            <div className="field">
              <label htmlFor="int-status">Estado</label>
              <select id="int-status" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
                <option value="">Todos</option>
                {Object.entries(INTERVENTION_STATUS_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="int-kind">Tipo</label>
              <select id="int-kind" value={filterKind} onChange={(e) => setFilterKind(e.target.value)}>
                <option value="">Todos</option>
                {Object.entries(KIND_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
          </div>

          {resolveError && <div className="error" role="alert">{resolveError}</div>}

          {items.length === 0 ? (
            <div className="notice">No hay intervenciones que requieran tu atención.</div>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Contexto</th>
                  <th>Estado</th>
                  <th>Creada</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id}>
                    <td>
                      <span className="badge">{kindLabel(it.kind)}</span>
                      {it.applicationId && (
                        <div className="muted" style={{ marginTop: '0.25rem', fontSize: '0.8rem' }}>
                          candidatura {it.applicationId}
                        </div>
                      )}
                    </td>
                    <td style={{ maxWidth: 420 }}>{renderContext(it.context)}</td>
                    <td>
                      <span className={statusBadgeClass(it.status)}>
                        {INTERVENTION_STATUS_LABELS[it.status] ?? it.status}
                      </span>
                    </td>
                    <td>{formatDate(it.createdAt)}</td>
                    <td>
                      {it.status === 'pendiente' ? (
                        <div className="resolve-form">
                          <input
                            type="text"
                            placeholder="Nota (opcional)"
                            value={notes[it.id] ?? ''}
                            onChange={(e) => setNotes((n) => ({ ...n, [it.id]: e.target.value }))}
                            maxLength={500}
                            aria-label="Nota de resolución"
                          />
                          <div className="actions-row">
                            <button
                              type="button"
                              className="btn btn-small"
                              disabled={busyId === it.id}
                              onClick={(e) => void onResolve(e, it.id, 'resuelta')}
                            >
                              Resolver
                            </button>
                            <button
                              type="button"
                              className="btn btn-small btn-ghost"
                              disabled={busyId === it.id}
                              onClick={(e) => void onResolve(e, it.id, 'descartada')}
                            >
                              Descartar
                            </button>
                          </div>
                        </div>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </>
  );
}
