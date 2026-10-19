/**
 * Página «Autonomía» (fase 4): autorización de la política y parada global.
 *
 * La lógica vive en el componente cliente AutonomyClient; esta página solo
 * proporciona el marco de servidor.
 */
import AutonomyClient from '@/components/AutonomyClient';

export const dynamic = 'force-dynamic';

export default function AutonomiaPage() {
  return (
    <>
      <h1>Autonomía</h1>
      <p className="muted">
        Política de autonomía del motor: modos, límites y presupuestos. El modo
        «Preparar para revisión» es el predeterminado; el envío automático
        necesita tu autorización escrita expresa.
      </p>
      <AutonomyClient />
    </>
  );
}
