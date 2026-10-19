# @jobforce/docs

Generación determinista de documentos de candidatura (CV y carta de presentación)
a partir del perfil versionado de Jon. **Sin LLM**: las plantillas
`cv-template-v1` y `cover-letter-template-v1` son funciones TypeScript puras que
seleccionan, reordenan y enfatizan hechos del perfil — nunca inventan contenido.

## Estructura

- `src/profile.ts` — los 21 hechos del perfil (única fuente de verdad).
  `identity.phone` es `null` en el perfil versionado y se inyecta al generar
  vía variable de entorno, de modo que el teléfono solo existe dentro de los
  documentos generados, nunca en el código ni en los informes.
- `src/templates/cv-template-v1.ts` — construye un `CvModel` puro y lo
  renderiza a HTML (base del PDF y del preview PNG).
- `src/templates/cover-letter-template-v1.ts` — idem para la carta.
- `src/docx-render.ts` — DOCX ATS-legible (una columna, Calibri, sin tablas)
  con el paquete `docx`, más `extractDocxText()` para validación.
- `src/browser.ts` — HTML → PDF (A4) y PNG con Playwright/Chromium headless.
- `src/manifest.ts` — `buildManifest()` (rutas, bytes, sha256, versiones de
  plantilla, hechos usados, gaps) y `validateDocuments()` (checklist pre-envío).

## Reglas de honestidad (se verifican en tests y en validación)

- Nunca se atribuyen a Jon certificaciones ACCA/ACA/CPA/CMA/CIMA ni un
  "Master's degree in Finance" (no los tiene).
- El Executive MBA aparece siempre como **título propio (non-official degree)**.
- Los requisitos de la oferta no cubiertos se declaran en `manifest.gaps`,
  nunca se maquillan.

## Instalación de dependencias (nota de entorno)

El FS de esta VM bloquea `chown` y `pnpm add` / `npm install` fallan al enlazar
binarios (`EPERM: operation not permitted, chown`). Por eso las dependencias
(`docx@9.1.1` + su árbol, `playwright-core@1.63.0`, `@types/node@22.20.5`
copiado de otro paquete del workspace) se instalaron **vendidas a mano** en
`packages/docs/node_modules/` descargando los tarballs de registry.npmjs.org
y extrayéndolos sin pasar por el gestor. `pnpm-lock.yaml` no se tocó; cuando
el entorno lo permita, ejecutar `pnpm install` en la raíz para normalizar el
lockfile. `playwright-core` usa el Chromium de `~/.cache/ms-playwright`
(resolución automática en `src/browser.ts`, o `PLAYWRIGHT_CHROMIUM_EXE`).

## Scripts

- `pnpm run build` — compila a `dist/`.
- `pnpm test` — compila, compila tests a `.test-dist/` y ejecuta `node --test`.
- `pnpm run typecheck` — verificación de tipos sin emitir.

## Generación de una candidatura (ejemplo Fase 3)

El script específico de cada candidatura vive **fuera del repo** (contiene la
adaptación a la oferta y recibe el teléfono por entorno):

```
JOBFORCE_PHONE="+34 ..." node ~/workspace/jobforce/fase3/bin/generate-fase3-docs.mjs
```

Genera `cv.docx`, `cv.pdf`, `carta.docx`, `carta.pdf`, `preview-cv.png`,
`preview-carta.png` y `manifest.json`, y ejecuta `validateDocuments()`
(38 checks: existencia/tamaño/sha256, sin marcadores, sin reivindicaciones
prohibidas, EMBA declarado como título propio, contacto correcto, PDF con
texto extraíble, manifest consistente).
