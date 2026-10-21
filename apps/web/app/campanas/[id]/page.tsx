import Link from 'next/link';
import { apiGet } from '@/lib/api';
import type { Campaign } from '@jobforce/domain';
import CriteriaEditor from '@/components/CriteriaEditor';
import DeleteOfferButton from '@/components/DeleteOfferButton';
import SearchLauncher from '@/components/SearchLauncher';
import ReportViewer from '@/components/ReportViewer';
import {
  APPLICATION_STATUS_LABELS,
  applicationBadgeClass,
  fmtUsd,
  statusBadgeClass,
  STATUS_LABELS,
  toNumber,
  verdictBadgeClass,
  VERDICT_LABELS,
  type OfferSummary,
} from '@/lib/campaigns';

export const dynamic = 'force-dynamic';

/**
 * La campaña de Fase 3 guarda `criteria` con forma propia
 * ({nota, fuente, criterios, generada_en}), no CampaignCriteria.
 * El editor estándar reventaría con `criteria.roles.join`; estas campañas
 * históricas se muestran en solo lectura.
 */
function isStandardCriteria(c: unknown): boolean {
  return (
    !!c &&
    typeof c === 'object' &&
    Array.isArray((c as Record<string, unknown>).roles) &&
    typeof (c as Record<string, unknown>).preferences === 'object'
  );
}

function CustomCriteriaView({ criteria }: { criteria: Record<string, unknown> }) {
  const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '—' : JSON.stringify(v));
  return (
    <dl style={{ display: 'grid', gap: '0.6rem', margin: 0 }}>
      {Object.entries(criteria).map(([k, v]) => (
        <div key={k}>
          <dt className="muted" style={{ fontSize: '0.85rem', textTransform: 'uppercase' }}>{k}</dt>
          <dd style={{ margin: '0.15rem 0 0' }}>{str(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Detalle de campaña (contrato §6):
 * - GET /api/campaigns/:id → editor de criterios (PUT /api/campaigns/:id).
 * - POST /api/campaigns/:id/search → lanzar búsqueda.
 * - GET /api/campaigns/:id/offers → tabla de ofertas.
 * - GET /api/campaigns/:id/report → informe.
 */
export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const enc = encodeURIComponent(id);

  const [campaignRes, offersRes] = await Promise.all([
    apiGet<{ campaign: Campaign }>(`/api/campaigns/${enc}`),
    apiGet<{ offers: OfferSummary[] }>(`/api/campaigns/${enc}/offers`),
  ]);

  if (!campaignRes.ok) {
    return (
      <>
        <p>
          <Link href="/campanas">← Volver a campañas</Link>
        </p>
        <h1>Campaña</h1>
        <div className="error" role="alert">{campaignRes.message}</div>
      </>
    );
  }
  const campaign = campaignRes.data.campaign;

  return (
    <>
      <p>
        <Link href="/campanas">← Volver a campañas</Link>
      </p>
      <h1>{campaign.name}</h1>
      <p>
        <span className={statusBadgeClass(campaign.status)}>{STATUS_LABELS[campaign.status]}</span>{' '}
        <span className="muted">
          Gasto Exa: {fmtUsd(campaign.exa_spent_usd, 4)} de {fmtUsd(campaign.exa_budget_cap_usd)}
          {' · '}Actualizada: {new Date(campaign.updated_at).toLocaleString('es-ES')}
        </span>
      </p>

      <h2>Criterios</h2>
      {isStandardCriteria(campaign.criteria) ? (
        <CriteriaEditor campaign={campaign} />
      ) : (
        <div className="card">
          <p className="muted" style={{ marginTop: 0 }}>
            Esta campaña usa un formato de criterios propio (histórica, no editable aquí).
          </p>
          <CustomCriteriaView criteria={campaign.criteria as unknown as Record<string, unknown>} />
        </div>
      )}

      <h2>Búsqueda</h2>
      <SearchLauncher campaignId={campaign.id} />

      <h2>Ofertas</h2>
      {!offersRes.ok ? (
        <div className="error" role="alert">{offersRes.message}</div>
      ) : offersRes.data.offers.length === 0 ? (
        <div className="notice">
          Aún no hay ofertas en esta campaña. Lanza una búsqueda para empezar.
        </div>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Título</th>
              <th>Empresa</th>
              <th>Veredicto</th>
              <th>Puntuación</th>
              <th>Candidatura</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {offersRes.data.offers.map((o) => {
              const score = o.evaluation ? toNumber(o.evaluation.score) : null;
              return (
                <tr key={o.id}>
                  <td>
                    {o.url ? (
                      <a href={o.url} target="_blank" rel="noreferrer">
                        {o.title || o.url}
                      </a>
                    ) : (
                      o.title || '—'
                    )}
                    {o.url_ok === false && (
                      <>
                        {' '}
                        <span className="badge danger" title="Enlace confirmado roto: la página devuelve 404 verificado o el dominio no existe">
                          enlace roto
                        </span>
                      </>
                    )}
                  </td>
                  <td>
                    {o.company || '—'}
                    {o.application_email ? (
                      <span title={`Se aplica por email: ${o.application_email}`}> 📧</span>
                    ) : null}
                  </td>
                  <td>
                    {o.evaluation ? (
                      <span className={verdictBadgeClass(o.evaluation.mandatory_verdict)}>
                        {VERDICT_LABELS[o.evaluation.mandatory_verdict]}
                      </span>
                    ) : (
                      <span className="muted">Sin evaluar</span>
                    )}
                  </td>
                  <td>{score === null ? '—' : score.toFixed(2)}</td>
                  <td>
                    {o.application ? (
                      <>
                        <span className={applicationBadgeClass(o.application.status)}>
                          {APPLICATION_STATUS_LABELS[o.application.status] ?? o.application.status}
                        </span>
                        {o.application.documents && o.application.documents.length > 0 && (
                          <span style={{ display: 'block', marginTop: '0.3rem' }}>
                            {o.application.documents.map((d) => (
                              <a
                                key={d.id}
                                href={`/api/documents/${d.id}/download`}
                                download
                                style={{ marginRight: '0.6rem', whiteSpace: 'nowrap' }}
                              >
                                ⬇ {d.kind === 'cv' ? 'CV' : 'Carta'}
                              </a>
                            ))}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <Link href={`/campanas/${campaign.id}/ofertas/${o.id}`}>Ver</Link>
                    {o.application?.status === 'withdrawn' && (
                      <DeleteOfferButton
                        campaignId={campaign.id}
                        offerId={o.id}
                        offerTitle={o.title || o.url || 'esta oferta'}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h2>Informe</h2>
      <ReportViewer campaignId={campaign.id} />
    </>
  );
}
