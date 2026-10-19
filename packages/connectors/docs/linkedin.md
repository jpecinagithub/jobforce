# LinkedIn en JOBFORCE: solo como pista, nunca como destino de envío

> Estado (Fase 4, 19-oct-2026): LinkedIn **no** tiene conector en este
> paquete. Esta nota documenta el rol que se le asigna y el flujo propuesto.

## Principio

LinkedIn sirve como **pista hacia la oferta corporativa**, no como portal
donde presentar la candidatura. Motivos:

1. **Términos de servicio**: el envío automatizado de candidaturas
   ("Easy Apply" por bot) viola las condiciones de uso de LinkedIn y puede
   provocar la restricción o el cierre de la cuenta de Jon. No se
   automatiza ningún apply en LinkedIn.
2. **Calidad de la evidencia**: la oferta corporativa (el ATS de la empresa:
   Ashby, SmartRecruiters, Workday, Greenhouse, Lever o su portal propio)
   es la fuente canónica para verificar vigencia, leer el detalle completo
   y presentar la candidatura con trazabilidad.
3. **Coherencia con la Fase 3**: el único envío real ejecutado hasta ahora
   fue en el portal corporativo (Personio de HomeToGo), con verificación
   previa de apertura y aprobación explícita de Jon.

## Flujo asistido propuesto

1. **Descubrimiento**: la oferta aparece en LinkedIn (búsqueda manual de Jon,
   alerta de LinkedIn, o resultado de una campaña Exa). Se registra su URL.
2. **Salto al corporativo**: se sigue el enlace "Apply" / "Company website"
   de la oferta hasta el ATS de la empresa. La mayoría de ofertas de
   LinkedIn enlazan al portal corporativo.
3. **Verificación con el conector correspondiente** (`@jobforce/connectors`):
   comprobar que la oferta sigue abierta (detección de cierre probada para
   los seis portales; ver `docs/matriz-conectores.md`) y descargar el
   detalle completo.
4. **Documentos**: generar CV y carta adaptados (paquete `@jobforce/docs`,
   38/38 checks como en la Fase 3) y entregar el **paquete de aprobación**
   a Jon.
5. **Modo asistido**: con la aprobación de Jon, Playwright rellena el
   formulario del portal corporativo (CV + carta subidos, sin enviar).
   Jon revisa y da el "apruebo"/"stop". Solo entonces se pulsa Submit —
   igual que en la Fase 3.
6. **Seguimiento**: vigilancia en Gmail de la confirmación y de respuestas
   (clasificación confirmacion/rechazo/entrevista/ambiguo), como ya opera
   para HomeToGo.

## Lo que NO se hace

- No hay auto-apply en LinkedIn (ni Easy Apply ni formularios de LinkedIn).
- No hay scraping masivo de LinkedIn ni de perfiles.
- No se crea actividad automatizada en la cuenta de LinkedIn de Jon
  (mensajes, conexiones, "me gusta") sin su aprobación explícita caso por caso.
