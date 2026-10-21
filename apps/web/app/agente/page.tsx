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
        oferta: …») y me encargo de todo: compruebo que sigue viva y, si el anuncio deriva
        la aplicación a otro portal, sigo la derivación y trabajo sobre la oferta real.
        Registro la oferta, genero el CV y la carta a medida y envío la candidatura:
        en <strong>Personio</strong> de forma automática, y <strong>por correo</strong> cuando
        el anuncio lo pide y Gmail tiene permiso de envío. Si un portal no me deja aplicar
        solo, te digo el motivo concreto y te dejo todo preparado en Revisión. Tu orden en
        el chat cuenta como aprobación expresa de esa candidatura concreta.
      </div>
      <AgentChat />
    </>
  );
}
