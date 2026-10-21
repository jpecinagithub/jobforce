'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import ConfirmModal, { type Confirmacion } from '@/components/ConfirmModal';
import { parseApiError } from '@/lib/campaigns';

/**
 * Icono de papelera para eliminar una oferta y su candidatura
 * (petición de Jon, 21-oct-2026): aparece junto a «Ver» en la tabla de
 * ofertas para CUALQUIER candidatura, sin texto, solo el icono típico
 * de delete. El backend solo protege lo ya enviado de verdad (409).
 * Borrado definitivo: oferta, evaluación, candidatura y documentos.
 */
export default function DeleteOfferButton({
  campaignId,
  offerId,
  offerTitle,
}: {
  campaignId: string;
  offerId: string;
  offerTitle: string;
}) {
  const router = useRouter();
  const { mutatingHeaders } = useAuth();
  const [confirmacion, setConfirmacion] = useState<Confirmacion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [borrando, setBorrando] = useState(false);

  async function borrar() {
    setBorrando(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/campaigns/${encodeURIComponent(campaignId)}/offers/${encodeURIComponent(offerId)}`,
        { method: 'DELETE', headers: mutatingHeaders() },
      );
      if (!res.ok) {
        const clone = res.clone();
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(
          body?.error === 'oferta_con_envios_reales'
            ? 'Esta candidatura ya se envió de verdad y no se borra: es tu historial.'
            : await parseApiError(clone),
        );
        return;
      }
      router.refresh();
    } catch {
      setError('No se pudo contactar con el servidor. Inténtalo de nuevo.');
    } finally {
      setBorrando(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-ghost"
        disabled={borrando}
        title="Eliminar"
        aria-label="Eliminar"
        style={{ marginLeft: '0.6rem', padding: '0.25rem 0.4rem', lineHeight: 0 }}
        onClick={() =>
          setConfirmacion({
            titulo: 'Eliminar oferta',
            cuerpo: (
              <>
                <p>
                  Vas a eliminar <strong>{offerTitle}</strong> con su evaluación,
                  su candidatura y sus documentos.
                </p>
                <p className="muted">No se puede deshacer.</p>
              </>
            ),
            textoConfirmar: 'Eliminar',
            onConfirm: () => void borrar(),
          })
        }
      >
        {borrando ? (
          '…'
        ) : (
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3 6h18" />
            <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6" />
            <path d="M14 11v6" />
          </svg>
        )}
      </button>
      {error && (
        <span className="error" role="alert" style={{ display: 'block', marginTop: '0.3rem' }}>
          {error}
        </span>
      )}
      <ConfirmModal confirmacion={confirmacion} onClose={() => setConfirmacion(null)} />
    </>
  );
}
