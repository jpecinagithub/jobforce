/**
 * Página «Etiquetas» (Fase 6.4): dataset etiquetado para medir precisión.
 *
 * Jon etiqueta ofertas y correos con su criterio; el sistema compara esas
 * etiquetas reales con sus predicciones y calcula precisión/recall/exactitud
 * en la pestaña «Precisión». Las métricas nunca usan la confianza del LLM.
 */
import LabelsClient from '@/components/LabelsClient';

export const dynamic = 'force-dynamic';

export default function EtiquetasPage() {
  return (
    <>
      <h1>Etiquetas</h1>
      <div className="notice">
        <strong>Cómo etiquetar (léeme primero):</strong>
        <ol>
          <li>
            <strong>Ofertas:</strong> «Sí encaja» = la enviarías tú mismo tras leerla; «No encaja»
            = la descartarías de verdad. Decide con tu criterio antes de mirar la predicción del
            sistema si puedes.
          </li>
          <li>
            <strong>Correos:</strong> elige lo que el mensaje <em>realmente</em> es —
            confirmación (la empresa confirma algo), rechazo (te descartan), entrevista (te
            invitan al proceso), ambiguo (no se puede decidir) u otro. Decide antes de mirar lo
            que predijo el sistema.
          </li>
          <li>
            <strong>Precisión:</strong> compara tus etiquetas con las predicciones del sistema.
            Solo cuenta tu criterio; la confianza que declara el modelo no interviene.
          </li>
        </ol>
      </div>
      <LabelsClient />
    </>
  );
}
