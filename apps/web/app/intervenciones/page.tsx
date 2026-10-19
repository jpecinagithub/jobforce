/**
 * Página «Intervenciones» (fase 4): bandeja de tareas del motor que
 * requieren atención humana. Una tarea bloqueada no detiene las demás.
 */
import InterventionsClient from '@/components/InterventionsClient';

export const dynamic = 'force-dynamic';

export default function IntervencionesPage() {
  return (
    <>
      <h1>Intervenciones</h1>
      <p className="muted">
        El motor pide tu criterio cuando encuentra datos desconocidos, preguntas ambiguas,
        CAPTCHA/MFA, situaciones fuera de la política o envíos inciertos.
        <strong> Una tarea bloqueada no detiene las demás.</strong>
      </p>
      <InterventionsClient />
    </>
  );
}
