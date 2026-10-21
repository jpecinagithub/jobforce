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
type SortKey = 'fecha' | 'empresa' | 'puesto' | 'nota' | 'canal' | 'estado';

/** Valor por el que se ordena una fila según la columna (el visible). */
function valorOrden(it: HistoryItem, key: SortKey): string | number | null {
  switch (key) {
    case 'fecha':
      return new Date(it.submittedAt ?? it.createdAt).getTime();
    case 'empresa':
      return (it.offer.company || 'Empresa desconocida').toLowerCase();
    case 'puesto':
      return (it.offer.title || 'Sin título').toLowerCase();
    case 'nota':
      return it.score;
    case 'canal':
      return channelLabel(it.channel).toLowerCase();
    case 'estado':
      return (APPLICATION_STATUS_LABELS[it.status] ?? it.status).toLowerCase();
  }
}

export default function HistoryClient() {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Ordenación por clic en la cabecera (petición de Jon, 21-oct-2026):
  // defecto = fecha descendente, como devuelve la API.
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'fecha', dir: -1 });

  function alOrdenar(key: SortKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 1 ? -1 : 1 }
        : { key, dir: key === 'fecha' || key === 'nota' ? -1 : 1 },
    );
  }

  function cabecera(key: SortKey, texto: string) {
    const activa = sort.key === key;
    return (
      <th aria-sort={activa ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
        <button
          type="button"
          className="th-sort"
          onClick={() => alOrdenar(key)}
          title={`Ordenar por ${texto.toLowerCase()}`}
        >
          {texto}
          {activa ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
        </button>
      </th>
    );
  }

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

  const ordenados = [...items].sort((a, b) => {
    const va = valorOrden(a, sort.key);
    const vb = valorOrden(b, sort.key);
    if (va === null && vb === null) return 0;
    if (va === null) return 1; // los nulos (nota sin evaluar) siempre al final
    if (vb === null) return -1;
    const cmp =
      typeof va === 'number' && typeof vb === 'number'
        ? va - vb
        : String(va).localeCompare(String(vb), 'es');
    return cmp * sort.dir;
  });

  return (
    <table className="data">
      <thead>
        <tr>
          {cabecera('fecha', 'Fecha de aplicación')}
          {cabecera('empresa', 'Empresa')}
          {cabecera('puesto', 'Puesto')}
          {cabecera('nota', 'Nota')}
          {cabecera('canal', 'Canal')}
          {cabecera('estado', 'Estado')}
          <th>CV</th>
        </tr>
      </thead>
      <tbody>
        {ordenados.map((it) => (
          <tr key={it.id}>
            {/* Fecha de aplicación = envío si lo hubo; si la candidatura
                aún no se envió (en revisión, aprobada, fallida, retirada),
                la de su creación/preparación: la columna nunca va vacía
                y el estado ya dice si llegó a enviarse (Jon, 21-oct). */}
            <td>{fecha(it.submittedAt ?? it.createdAt)}</td>
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
              {/* Solo el CV (decisión de Jon, 20-oct-2026): la carta no se
                  muestra en el histórico aunque exista el documento. */}
              {(() => {
                const cv = it.documents.find((d) => d.kind === 'cv' && d.format === 'pdf')
                  ?? it.documents.find((d) => d.kind === 'cv');
                return cv ? (
                  <a className="btn btn-ghost btn-small" href={`/api/documents/${cv.id}/download`}>
                    {docLabel(cv.kind, cv.format)}
                  </a>
                ) : (
                  '—'
                );
              })()}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
