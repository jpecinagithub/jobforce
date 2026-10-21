'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import ConfirmModal, { type Confirmacion } from '@/components/ConfirmModal';
import { parseApiError } from '@/lib/campaigns';

/**
 * Botón «Eliminar» de una oferta con la candidatura RETIRADA (petición
 * de Jon, 21-oct-2026): aparece junto a «Ver» en la tabla de ofertas
 * de la campaña solo cuando la candidatura está retirada. El backend
 * exige lo mismo (409 si no está retirada o si hubo envíos reales).
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
          body?.error === 'candidatura_no_retirada'
            ? 'Solo se puede eliminar una oferta con la candidatura retirada.'
            : body?.error === 'oferta_con_envios_reales'
              ? 'Esta oferta tiene envíos reales y no se borra: es tu historial.'
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
        style={{ marginLeft: '0.6rem' }}
        onClick={() =>
          setConfirmacion({
            titulo: 'Eliminar oferta',
            cuerpo: (
              <>
                <p>
                  Vas a eliminar <strong>{offerTitle}</strong> con su evaluación,
                  su candidatura retirada y sus documentos.
                </p>
                <p className="muted">No se puede deshacer.</p>
              </>
            ),
            textoConfirmar: 'Eliminar',
            onConfirm: () => void borrar(),
          })
        }
      >
        {borrando ? 'Eliminando…' : 'Eliminar'}
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
