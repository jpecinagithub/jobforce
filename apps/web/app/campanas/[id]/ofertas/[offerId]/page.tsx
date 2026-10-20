import Link from 'next/link';
import type { ReactNode } from 'react';
import { apiGet } from '@/lib/api';
import PrepareApplication from '@/components/PrepareApplication';
import {
  PREFERENCE_LABELS,
  toNumber,
  verdictBadgeClass,
  VERDICT_LABELS,
  type DimensionScore,
  type EvaluationResult,
  type MandatoryState,
  type OfferDetail,
} from '@/lib/campaigns';

export const dynamic = 'force-dynamic';

/**
 * Los highlights de Exa vienen con markdown (#, **…**). Se muestra el
 * texto limpio sin renderizar HTML (sin riesgo de inyección).
 */
function cleanHighlight(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();
}

interface OfferDetailResponse {
  offer: OfferDetail;
  evaluation: EvaluationResult | null;
}

/**
 * Vista de oferta (contrato §6: GET /api/campaigns/:id/offers/:offerId):
 * highlights, desglose por dimensión (puntos, explicación, hechos
 * referenciados) y detalles de obligatorios con evidencia.
 */
export default async function OfferDetailPage({
  params,
}: {
  params: Promise<{ id: string; offerId: string }>;
}) {
  const { id, offerId } = await params;
  const res = await apiGet<OfferDetailResponse>(
    `/api/campaigns/${encodeURIComponent(id)}/offers/${encodeURIComponent(offerId)}`,
  );

  if (!res.ok) {
    return (
      <>
        <p>
          <Link href={`/campanas/${id}`}>← Volver a la campaña</Link>
        </p>
        <h1>Oferta</h1>
        <div className="error" role="alert">{res.message}</div>
      </>
    );
  }

  const { offer, evaluation } = res.data;
  const score = evaluation ? toNumber(evaluation.score) : null;

  return (
    <>
      <p>
        <Link href={`/campanas/${id}`}>← Volver a la campaña</Link>
      </p>
      <h1>{offer.title || 'Oferta sin título'}</h1>
      <p className="muted">
        {offer.company ? <><strong>{offer.company}</strong>{' · '}</> : null}
        {offer.url ? (
          <a href={offer.url} target="_blank" rel="noreferrer">Abrir la oferta ↗</a>
        ) : null}
        {offer.published_date ? <> · Publicada: {offer.published_date}</> : null}
        {' · '}Recuperada: {new Date(offer.retrieved_at).toLocaleString('es-ES')}
      </p>

      {evaluation ? (
        <p>
          <span className={verdictBadgeClass(evaluation.mandatory_verdict)}>
            {VERDICT_LABELS[evaluation.mandatory_verdict]}
          </span>{' '}
          <strong>Puntuación: {score === null ? '—' : score.toFixed(2)}</strong>
          {score === null && (
            <span className="muted"> (solo se puntúa si cumple todos los obligatorios)</span>
          )}
        </p>
      ) : (
        <div className="notice">Esta oferta aún no tiene evaluación.</div>
      )}

      <h2>Candidatura</h2>
      <PrepareApplication
        campaignId={id}
        offerId={offerId}
        application={offer.application ?? null}
        hasEvaluation={evaluation !== null}
      />

      <h2>Fragmentos destacados</h2>
      {offer.highlights.length === 0 ? (
        <p className="muted">Sin fragmentos destacados.</p>
      ) : (
        <ul>
          {offer.highlights.map((h, i) => (
            <li key={i} style={{ marginBottom: '0.5rem' }}>«{cleanHighlight(h)}»</li>
          ))}
        </ul>
      )}

      {evaluation && (
        <>
          <h2>Desglose por dimensión</h2>
          <table className="data">
            <thead>
              <tr>
                <th>Dimensión</th>
                <th>Peso</th>
                <th>Puntos</th>
                <th>Explicación</th>
                <th>Hechos referenciados</th>
              </tr>
            </thead>
            <tbody>
              {evaluation.breakdown.map((d: DimensionScore) => (
                <tr key={d.dimension}>
                  <td><strong>{PREFERENCE_LABELS[d.dimension] ?? d.dimension}</strong></td>
                  <td>{d.peso}</td>
                  <td>{d.puntos}</td>
                  <td>{d.explicacion}</td>
                  <td className="muted">
                    {d.hechos.length === 0 ? '—' : d.hechos.map((h) => <code key={h}>{h}</code>).reduce<ReactNode[]>(
                      (acc, el, i) => (i === 0 ? [el] : [...acc, ', ', el]),
                      [],
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>Requisitos obligatorios</h2>
          <table className="data">
            <thead>
              <tr>
                <th>Requisito</th>
                <th>Estado</th>
                <th>Evidencia</th>
              </tr>
            </thead>
            <tbody>
              {evaluation.mandatory_details.map((m) => (
                <tr key={m.requisito_id}>
                  <td>
                    <strong>{m.requisito_id}</strong>
                    <br />
                    <span className="muted">{m.descripcion}</span>
                  </td>
                  <td>
                    <span className={verdictBadgeClass(m.estado as MandatoryState)}>
                      {VERDICT_LABELS[m.estado as MandatoryState]}
                    </span>
                  </td>
                  <td className="muted">{m.evidencia || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h2>Detalles técnicos</h2>
      <dl className="fact">
        <dt>URL canónica</dt>
        <dd><code>{offer.canonical_url}</code></dd>
        <dt>Coste de la búsqueda</dt>
        <dd className="muted">El gasto Exa se contabiliza a nivel de campaña (ver página de la campaña).</dd>
      </dl>
    </>
  );
}
