/**
 * Página «Histórico»: todas las candidaturas con empresa, puesto, nota,
 * canal, estado y fecha de aplicación, y el CV/carta descargables.
 * Petición de Jon (20-oct-2026): el histórico visible desde la aplicación.
 */
import HistoryClient from '@/components/HistoryClient';

export const dynamic = 'force-dynamic';

export default function HistoricoPage() {
  return (
    <>
      <h1>Histórico de aplicaciones</h1>
      <p className="muted">
        Todas tus candidaturas, de la más reciente a la más antigua: a qué empresa,
        con qué nota, por qué canal y cuándo se aplicó. Desde aquí puedes bajar
        el CV exacto que se envió en cada una.
      </p>
      <HistoryClient />
    </>
  );
}
