'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import ConfirmModal, { type Confirmacion } from '@/components/ConfirmModal';
import { parseApiError } from '@/lib/campaigns';

/**
 * Botón de borrado definitivo de una campaña (petición de Jon, 20-oct-2026).
 * Pide confirmación con el modal del panel: el borrado elimina también las
 * ofertas, búsquedas y candidaturas de la campaña y no se puede deshacer.
 * El backend protege las campañas con envíos reales (responde 409).
 */
export default function DeleteCampaignButton({
  campaignId,
  campaignName,
}: {
  campaignId: string;
  campaignName: string;
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
      const res = await fetch(`/api/campaigns/${encodeURIComponent(campaignId)}`, {
        method: 'DELETE',
        headers: mutatingHeaders(),
      });
      if (!res.ok) {
        const clone = res.clone();
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(
          body?.error === 'campana_con_envios_reales'
            ? 'Esta campaña tiene candidaturas ya enviadas y no se puede borrar: es tu historial real.'
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
        onClick={() =>
          setConfirmacion({
            titulo: 'Borrar campaña',
            cuerpo: (
              <>
                <p>
                  Vas a borrar <strong>{campaignName}</strong> con todas sus ofertas,
                  búsquedas y candidaturas.
                </p>
                <p className="muted">No se puede deshacer.</p>
              </>
            ),
            textoConfirmar: 'Borrar campaña',
            onConfirm: () => void borrar(),
          })
        }
      >
        {borrando ? 'Borrando…' : 'Borrar'}
      </button>
      {error && (
        <span className="error" role="alert" style={{ marginLeft: '0.5rem' }}>
          {error}
        </span>
      )}
      <ConfirmModal confirmacion={confirmacion} onClose={() => setConfirmacion(null)} />
    </>
  );
}
