/**
 * Página «Cambios» (fase 6.2): propuestas de cambios de código.
 *
 * El agente implementa en una rama; aquí se hace el seguimiento, se
 * autoriza la publicación con declaración expresa y se ejecuta la
 * reversión en un clic. La lógica vive en CodeChangesClient.
 */
import CodeChangesClient from '@/components/CodeChangesClient';

export const dynamic = 'force-dynamic';

export default function CambiosPage() {
  return (
    <>
      <h1>Cambios de código</h1>
      <p className="muted">
        Propuestas de cambios: el agente las implementa en una rama, tú las
        sigues aquí, autorizas su publicación con una declaración expresa y,
        si algo sale mal, las reviertes en un clic. Cada paso queda auditado.
      </p>
      <CodeChangesClient />
    </>
  );
}
