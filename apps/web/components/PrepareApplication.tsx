'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { parseApiError } from '@/lib/autonomy';
import { APPLICATION_STATUS_LABELS, applicationBadgeClass } from '@/lib/campaigns';

/**
 * Preparación manual de la candidatura desde el detalle de la oferta
 * (Fase 7): llama a POST /api/campaigns/:id/offers/:offerId/prepare.
 * Si ya existe candidatura, muestra su estado y enlaza a /revision
 * cuando está lista para revisar.
 */
export default function PrepareApplication({
  campaignId,
  offerId,
  application,
  hasEvaluation,
}: {
  campaignId: string;
  offerId: string;
  application: { id: string; status: string } | null;
  hasEvaluation: boolean;
}) {
  const { mutatingHeaders } = useAuth();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nota, setNota] = useState<string | null>(null);

  if (application) {
    return (
      <p>
        <span className={applicationBadgeClass(application.status)}>
          Candidatura: {APPLICATION_STATUS_LABELS[application.status] ?? application.status}
        </span>{' '}
        {application.status === 'ready_for_review' && (
          <Link href="/revision">Ir a Revisión para aprobarla →</Link>
        )}
        {application.status === 'draft' && (
          <span className="muted">
            La preparación quedó en borrador (revisa el motivo en el servidor o vuelve a intentarlo
            desde esta página tras recargar).
          </span>
        )}
      </p>
    );
  }

  async function preparar() {
    setError(null);
    setNota(null);
    setBusy(true);
    try {
      const res = await fetch(
        `/api/campaigns/${encodeURIComponent(campaignId)}/offers/${encodeURIComponent(offerId)}/prepare`,
        { method: 'POST', headers: mutatingHeaders() },
      );
      if (!res.ok) throw new Error(await parseApiError(res));
      const body = (await res.json()) as {
        application: { status: string; failureReason?: string | null };
      };
      if (body.application.status === 'ready_for_review') {
        setNota('Candidatura preparada con sus documentos.');
      } else {
        setNota(
          `La candidatura quedó en «${body.application.status}»` +
            (body.application.failureReason ? `: ${body.application.failureReason}` : '.'),
        );
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo preparar la candidatura.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        className="btn"
        disabled={busy || !hasEvaluation}
        onClick={() => void preparar()}
      >
        {busy ? 'Preparando…' : 'Preparar candidatura'}
      </button>
      {!hasEvaluation && (
        <p className="muted">
          Esta oferta aún no está evaluada: evalúala primero desde la página de la campaña.
        </p>
      )}
      {nota && (
        <p>
          {nota}{' '}
          <Link href="/revision">Ir a Revisión →</Link>
        </p>
      )}
      {error && (
        <div className="error" role="alert" style={{ marginTop: '0.5rem' }}>
          {error}
        </div>
      )}
    </div>
  );
}
