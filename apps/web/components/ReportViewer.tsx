'use client';

import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import {
  fmtUsd,
  toNumber,
  verdictBadgeClass,
  type CampaignReport,
  type MandatoryState,
} from '@/lib/campaigns';

/**
 * Botón "Generar informe" (contrato §6: GET /api/campaigns/:id/report).
 *
 * Renderiza: fuentes intentadas/inaccesibles, vacantes leídas, duplicados,
 * descartes con motivo y evidencia, nuevas coincidencias, gasto total vs
 * presupuesto.
 */
export default function ReportViewer({ campaignId }: { campaignId: string }) {
  const { mutatingHeaders } = useAuth();
  const [report, setReport] = useState<CampaignReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onGenerate() {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/campaigns/${encodeURIComponent(campaignId)}/report`, {
        headers: mutatingHeaders(),
      });
      if (!res.ok) {
        let detail = '';
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) detail = `: ${body.error}`;
        } catch {
          /* cuerpo no JSON */
        }
        setError(`No se pudo generar el informe (HTTP ${res.status}${detail}).`);
        return;
      }
      const body = (await res.json()) as { report: CampaignReport };
      setReport(body.report);
    } catch {
      setError('No se pudo conectar con el servidor.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button type="button" className="btn" onClick={onGenerate} disabled={loading}>
        {loading ? 'Generando…' : 'Generar informe'}
      </button>
      {error && <div className="error" role="alert" style={{ marginTop: '1rem' }}>{error}</div>}

      {report && (
        <section style={{ marginTop: '1.5rem' }}>
          <h3>Informe de campaña</h3>
          <p className="muted">
            Campaña:{' '}
            <strong>
              {typeof report.campana === 'string' ? report.campana : report.campana.nombre}
            </strong>
            {' · '}Generado: {report.generado_en ? new Date(report.generado_en).toLocaleString('es-ES') : '—'}
          </p>

          <div className="cards" style={{ marginBottom: '1rem' }}>
            <div className="card">
              <div className="label">Vacantes leídas</div>
              <div className="big">{report.vacantes_leidas}</div>
            </div>
            <div className="card">
              <div className="label">Duplicados descartados</div>
              <div className="big">{report.duplicados_descartados}</div>
            </div>
            <div className="card">
              <div className="label">Nuevas coincidencias</div>
              <div className="big">{report.nuevas_coincidencias}</div>
            </div>
            <div className="card">
              <div className="label">Gasto Exa</div>
              <div className="big" style={{ fontSize: '1.4rem' }}>
                {fmtUsd(report.gasto_total_usd)} <span className="muted" style={{ fontSize: '1rem' }}>/ {fmtUsd(report.presupuesto_usd)}</span>
              </div>
            </div>
          </div>

          <h3>Fuentes</h3>
          <p><strong>Intentadas ({report.fuentes_intentadas.length}):</strong></p>
          {report.fuentes_intentadas.length === 0 ? (
            <p className="muted">Ninguna.</p>
          ) : (
            <ul>{report.fuentes_intentadas.map((f) => <li key={f}><code>{f}</code></li>)}</ul>
          )}
          <p><strong>Inaccesibles ({report.fuentes_inaccesibles.length}):</strong></p>
          {report.fuentes_inaccesibles.length === 0 ? (
            <p className="muted">Ninguna.</p>
          ) : (
            <ul>{report.fuentes_inaccesibles.map((f) => <li key={f}><code>{f}</code></li>)}</ul>
          )}

          <h3>Búsquedas ({report.busquedas.length})</h3>
          {report.busquedas.length === 0 ? (
            <p className="muted">Aún no se ha lanzado ninguna búsqueda.</p>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Consulta</th>
                  <th>Estado</th>
                  <th>Resultados</th>
                  <th>Duplicados</th>
                  <th>Coste (USD)</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {report.busquedas.map((b, i) => (
                  <tr key={i}>
                    <td>{b.query}</td>
                    <td><span className={b.estado === 'done' ? 'badge active' : b.estado === 'error' ? 'badge danger' : 'badge pending'}>{b.estado}</span></td>
                    <td>{b.resultados}</td>
                    <td>{b.duplicados}</td>
                    <td>{fmtUsd(b.coste_usd, 4)}</td>
                    <td className="muted">{b.error ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>Ofertas que cumplen ({report.ofertas.length})</h3>
          {report.ofertas.length === 0 ? (
            <p className="muted">Ninguna oferta cumple los requisitos obligatorios.</p>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Título</th>
                  <th>Empresa</th>
                  <th>Veredicto</th>
                  <th>Puntuación</th>
                </tr>
              </thead>
              <tbody>
                {report.ofertas.map((o, i) => {
                  const score = toNumber(o.puntuacion);
                  return (
                    <tr key={i}>
                      <td>
                        <a href={o.url} target="_blank" rel="noreferrer">{o.titulo}</a>
                      </td>
                      <td>{o.empresa || '—'}</td>
                      <td>
                        <span className={verdictBadgeClass(o.veredicto as MandatoryState)}>{o.veredicto}</span>
                      </td>
                      <td>{score === null ? '—' : score.toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          <h3>Descartes ({report.descartes.length})</h3>
          {report.descartes.length === 0 ? (
            <p className="muted">Sin descartes.</p>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Título</th>
                  <th>Motivo</th>
                  <th>Evidencia</th>
                </tr>
              </thead>
              <tbody>
                {report.descartes.map((d, i) => (
                  <tr key={i}>
                    <td>{d.titulo}</td>
                    <td>{d.motivo}</td>
                    <td className="muted">{d.evidencia || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
