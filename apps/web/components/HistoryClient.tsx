'use client';

import { useEffect, useState } from 'react';
import {
  APPLICATION_STATUS_LABELS,
  channelLabel,
  type HistoryItem,
  type HistoryResponse,
} from '@/lib/review';

/** Fecha ISO → «20 oct 2026» (o «—» si no hay). */
function fecha(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
}

function docLabel(kind: string, format: string): string {
  if (kind === 'cv') return format === 'pdf' ? '⬇ CV (PDF)' : '⬇ CV';
  if (kind === 'cover_letter') return format === 'pdf' ? '⬇ Carta (PDF)' : '⬇ Carta';
  return `⬇ ${kind}`;
}

/**
 * Histórico de candidaturas: todas, con empresa, puesto, nota, canal,
 * estado y fecha de aplicación, y el CV/carta descargables. Es la vista
 * en la aplicación del registro que Jon pidió el 20-oct-2026.
 */
export default function HistoryClient() {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/applications/history', { cache: 'no-store' });
        if (!res.ok) throw new Error('error');
        const body = (await res.json()) as HistoryResponse;
        if (alive) setItems(body.history);
      } catch {
        if (alive) setError('No se pudo cargar el histórico. Recarga la página.');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <div className="error" role="alert">{error}</div>;
  if (items === null) return <p className="muted">Cargando…</p>;
  if (items.length === 0) {
    return <p className="muted">Todavía no hay candidaturas. Cuando una oferta se prepare, aparecerá aquí.</p>;
  }

  return (
    <table className="data">
      <thead>
        <tr>
          <th>Fecha de aplicación</th>
          <th>Empresa</th>
          <th>Puesto</th>
          <th>Nota</th>
          <th>Canal</th>
          <th>Estado</th>
          <th>Documentos</th>
        </tr>
      </thead>
      <tbody>
        {items.map((it) => (
          <tr key={it.id}>
            <td>{fecha(it.submittedAt)}</td>
            <td>{it.offer.company || 'Empresa desconocida'}</td>
            <td>
              <a href={it.offer.url} target="_blank" rel="noreferrer">
                {it.offer.title || 'Sin título'}
              </a>
              <br />
              <small className="muted">{it.campaign}</small>
            </td>
            <td>{it.score === null ? '—' : it.score.toFixed(2).replace('.', ',')}</td>
            <td>
              {channelLabel(it.channel)}
              {it.submittedTo ? (
                <>
                  <br />
                  <small className="muted">{it.submittedTo}</small>
                </>
              ) : null}
            </td>
            <td>{APPLICATION_STATUS_LABELS[it.status] ?? it.status}</td>
            <td>
              {it.documents.length === 0 ? (
                '—'
              ) : (
                <span style={{ display: 'inline-flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                  {it.documents.map((d) => (
                    <a
                      key={d.id}
                      className="btn btn-ghost btn-small"
                      href={`/api/documents/${d.id}/download`}
                    >
                      {docLabel(d.kind, d.format)}
                    </a>
                  ))}
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
