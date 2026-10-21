/**
 * Página «Agente»: chat de aplicación directa. El usuario pega la URL
 * de una oferta y el agente la ingiere, genera CV y carta, aprueba con
 * su orden expresa y envía la candidatura si el portal lo permite.
 */
import AgentChat from '@/components/AgentChat';

export const dynamic = 'force-dynamic';

export default function AgentePage() {
  return (
    <>
      <h1>Agente</h1>
      <div className="notice">
        <strong>Aplicación directa:</strong> pégame el enlace de una oferta («aplica a esta
        oferta: …») y me encargo de todo: compruebo que sigue viva, la registro, genero el CV
        y la carta a medida, y envío la candidatura. Hoy el envío totalmente autónomo funciona
        en <strong>Personio</strong>; en el resto de portales la candidatura queda preparada en
        Revisión y te aviso con el motivo. Tu orden en el chat cuenta como aprobación expresa
        de esa candidatura concreta.
      </div>
      <AgentChat />
    </>
  );
}
