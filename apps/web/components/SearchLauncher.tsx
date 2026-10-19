'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import {
  fmtUsd,
  mensajeErrorBusqueda,
  parseApiError,
  type SearchErrorBody,
  type SearchSummary,
} from '@/lib/campaigns';

/**
 * Botón "Lanzar búsqueda" (contrato §6: POST /api/campaigns/:id/search).
 *
 * num_results configurable 1..10 (por defecto 5). Las consultas son
 * opcionales: si se dejan en blanco el backend las genera desde los
 * criterios (generateQueries).
 *
 * Muestra el resumen (resultados, duplicados, coste) y los errores del
 * contrato (presupuesto_exa_agotado, exa_no_configurado) en lenguaje claro.
 */
export default function SearchLauncher({ campaignId }: { campaignId: string }) {
  const router = useRouter();
  const { mutatingHeaders } = useAuth();
  const [numResults, setNumResults] = useState(5);
  const [queriesText, setQueriesText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<SearchSummary | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSummary(null);
    if (!Number.isInteger(numResults) || numResults < 1 || numResults > 10) {
      setError('El número de resultados debe estar entre 1 y 10.');
      return;
    }
    const queries = queriesText.split('\n').map((q) => q.trim()).filter(Boolean);
    if (queries.length > 5) {
      setError('Máximo 5 consultas.');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/campaigns/${encodeURIComponent(campaignId)}/search`, {
        method: 'POST',
        headers: mutatingHeaders(),
        body: JSON.stringify({
          ...(queries.length > 0 ? { queries } : {}),
          num_results: numResults,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as SearchSummary & SearchErrorBody;
      if (!res.ok) {
        setError(res.status === 409 || res.status === 503 ? mensajeErrorBusqueda(body) : await parseApiError(res));
        return;
      }
      setSummary(body);
      router.refresh();
    } catch {
      setError('No se pudo conectar con el servidor.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <form onSubmit={onSubmit} style={{ maxWidth: 640 }}>
        {error && <div className="error" role="alert">{error}</div>}
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="sl-num">Resultados por consulta</label>
            <input
              id="sl-num"
              type="number"
              min={1}
              max={10}
              value={numResults}
              onChange={(e) => setNumResults(parseInt(e.target.value, 10))}
              style={{ width: '5rem' }}
            />
          </div>
          <button type="submit" className="btn" disabled={loading}>
            {loading ? 'Buscando…' : 'Lanzar búsqueda'}
          </button>
        </div>
        <div className="field" style={{ marginTop: '1rem' }}>
          <label htmlFor="sl-queries">Consultas (opcional, una por línea, máx 5)</label>
          <textarea
            id="sl-queries"
            rows={3}
            value={queriesText}
            onChange={(e) => setQueriesText(e.target.value)}
            placeholder="En blanco: se generan desde los criterios de la campaña"
          />
        </div>
        <p className="muted">
          <small>
            Cada consulta consume crédito de Exa. Antes de lanzar, el backend
            comprueba que el gasto estimado no supere el límite de la campaña.
          </small>
        </p>
      </form>

      {summary && (
        <section>
          <h3>Resumen de la búsqueda</h3>
          <table className="data">
            <thead>
              <tr>
                <th>Consulta</th>
                <th>Resultados</th>
                <th>Duplicados</th>
                <th>Coste (USD)</th>
              </tr>
            </thead>
            <tbody>
              {summary.searches.map((s) => (
                <tr key={s.id}>
                  <td>{s.query}</td>
                  <td>{s.results_count}</td>
                  <td>{s.duplicates_count}</td>
                  <td>{fmtUsd(s.cost_usd, 4)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td><strong>Total</strong></td>
                <td colSpan={2}></td>
                <td><strong>{fmtUsd(summary.total_cost_usd, 4)}</strong></td>
              </tr>
            </tfoot>
          </table>
          <p className="muted">
            <small>Las ofertas nuevas aparecen en la tabla de abajo, ya evaluadas.</small>
          </p>
        </section>
      )}
    </div>
  );
}
