/**
 * Página «Revisión» (Fase 6.1): cola de candidaturas en `ready_for_review`
 * con resumen de encaje. Jon aprueba o rechaza en un toque; el rechazo pide
 * un motivo y también hay acciones por lote sobre la selección.
 */
import ReviewQueueClient from '@/components/ReviewQueueClient';

export const dynamic = 'force-dynamic';

export default function RevisionPage() {
  return (
    <>
      <h1>Revisión</h1>
      <p className="muted">
        Candidaturas con el paquete de aprobación completo, pendientes de tu decisión.
        Aprobar deja la candidatura en <strong>approved</strong> (lista para enviar);
        rechazar la retira (<strong>withdrawn</strong>). Nada se envía desde aquí.
      </p>
      <ReviewQueueClient />
    </>
  );
}
