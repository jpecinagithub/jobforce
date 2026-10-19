import Link from 'next/link';
import { apiGet } from '@/lib/api';
import type { Campaign } from '@jobforce/domain';
import NewCampaignForm from '@/components/NewCampaignForm';
import { fmtUsd, statusBadgeClass, STATUS_LABELS } from '@/lib/campaigns';

export const dynamic = 'force-dynamic';

interface CampaignsResponse {
  campaigns: Campaign[];
}

/**
 * Lista de campañas (contrato §6: GET /api/campaigns) con nombre, estado,
 * gasto/límite USD y nº de ofertas, más el formulario de nueva campaña.
 */
export default async function CampanasPage() {
  const res = await apiGet<CampaignsResponse>('/api/campaigns');

  return (
    <>
      <h1>Campañas</h1>

      {!res.ok ? (
        <div className="error" role="alert">
          {res.status === 404
            ? 'El endpoint de campañas aún no está disponible en el backend (pendiente del worker A, contrato §6).'
            : res.message}
        </div>
      ) : res.data.campaigns.length === 0 ? (
        <div className="notice">
          Aún no hay campañas. Crea la primera con el formulario de abajo.
        </div>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Estado</th>
              <th>Gasto Exa</th>
              <th>Ofertas</th>
              <th>Búsquedas</th>
            </tr>
          </thead>
          <tbody>
            {res.data.campaigns.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link href={`/campanas/${c.id}`}>
                    <strong>{c.name}</strong>
                  </Link>
                </td>
                <td>
                  <span className={statusBadgeClass(c.status)}>{STATUS_LABELS[c.status]}</span>
                </td>
                <td>
                  {fmtUsd(c.exa_spent_usd, 4)}{' '}
                  <span className="muted">/ {fmtUsd(c.exa_budget_cap_usd)}</span>
                </td>
                <td>{c.offers_count ?? '—'}</td>
                <td>{c.searches_count ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Nueva campaña</h2>
      <NewCampaignForm />
    </>
  );
}
