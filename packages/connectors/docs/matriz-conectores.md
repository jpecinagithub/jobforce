# Matriz de capacidades de conectores de portales (JOBFORCE Fase 4)

> **Regla de esta matriz: nada ficticio.** Una capacidad se marca SÍ solo si se
> probó de verdad, con la fecha y la evidencia indicadas. Si no se probó, se
> marca NO con el motivo. Los probes en vivo están en
> `packages/connectors/scripts/probe-*.mjs`; las fixtures recortadas de
> respuestas reales, en `packages/connectors/test/fixtures/`.

## Resumen

| Capacidad \ Portal | Ashby | SmartRecruiters | Workday | Greenhouse | Lever | Personio |
|---|---|---|---|---|---|---|
| Descubrir ofertas (listado público) | ✅ 19-oct-2026 | ✅ 19-oct-2026 | ✅ 19-oct-2026 | ✅ 19-oct-2026 | ✅ 19-oct-2026 | ⚠️ parcial |
| Detalle de oferta | ✅ 19-oct-2026 | ✅ 19-oct-2026 | ✅ 19-oct-2026 | ✅ 19-oct-2026 | ✅ 19-oct-2026 | ✅ 19-oct-2026 |
| Detectar cierre / vigencia | ✅ 19-oct-2026 | ✅ 19-oct-2026 | ✅ 19-oct-2026 | ✅ 19-oct-2026 | ✅ 19-oct-2026 | ✅ 19-oct-2026 |
| URL de aplicación | ✅ 19-oct-2026 | ✅ 19-oct-2026 | ✅ 19-oct-2026 | ✅ 19-oct-2026 | ✅ 19-oct-2026 | ✅ 19-oct-2026 |
| Cliente tipado en `@jobforce/connectors` | ✅ F4 | ✅ F4 | ✅ F4 | ✅ **F6 (19-oct-2026)** | ❌ solo probado | n/a (driver Playwright) |
| Auto-relleno asistido (Playwright) | ❌ no probado | ❌ no probado | ❌ no probado | ❌ no probado | ❌ no probado | ✅ 19-oct-2026 |
| Envío | ❌ solo lectura | ❌ solo lectura | ❌ solo lectura | ❌ no probado | ❌ no probado | ✅ 19-oct-2026 (con aprobación) |

## Ashby — `api.ashbyhq.com` (Posting API pública, sin clave)

Validado en vivo el **19-oct-2026** con dos `orgHost` reales:

| Capacidad | Probado | Fecha | Notas / evidencia |
|---|---|---|---|
| Descubrir ofertas | SÍ | 19-oct-2026 | `GET /posting-api/job-board/{orgHost}?includeCompensation=true` → HTTP 200. "notion": 129 ofertas; "linear": 29. La respuesta **ya incluye la descripción completa** (`descriptionHtml` + `descriptionPlain`), `location`, `isRemote`, `publishedAt`, `jobUrl` y `applyUrl`. |
| Detalle de oferta | SÍ (vía listado) | 19-oct-2026 | El endpoint de detalle por id de la Posting API **exige API key** (401 sin clave; probado). El detalle se obtiene buscando el id dentro del listado, o en la página pública `jobs.ashbyhq.com/{orgHost}/{jobId}` (HTTP 200, título en `<title>`). |
| Detectar cierre | SÍ | 19-oct-2026 | Organización inexistente → HTTP 404. Oferta eliminada: desaparece del listado; su página pública pasa a mostrar el título genérico "Jobs" (probado con id bogus). |
| URL de aplicación | SÍ | 19-oct-2026 | Patrón `https://jobs.ashbyhq.com/{orgHost}/{jobId}/application` — coincide con el campo `applyUrl` devuelto por la API. |
| Auto-relleno asistido | NO | — | Formulario propio de Ashby; no se ha rellenado con Playwright. |
| Envío | NO | — | La API pública es de solo lectura. |

## SmartRecruiters — `api.smartrecruiters.com` (público, sin clave)

Validado en vivo el **19-oct-2026** con la company real `SiloamCareers` (720 postings):

| Capacidad | Probado | Fecha | Notas / evidencia |
|---|---|---|---|
| Descubrir ofertas | SÍ | 19-oct-2026 | `GET /v1/companies/{company}/postings?limit=&offset=` → HTTP 200 con `{totalFound, content}`. **Paginado obligatorio**; el listado devuelve solo metadatos (sin descripción). Una company desconocida ("Visa") devolvió `totalFound: 0` — la API es permisiva: hay que validar `totalFound`. |
| Detalle de oferta | SÍ | 19-oct-2026 | `GET /v1/companies/{company}/postings/{id}` → HTTP 200: `jobAd.sections` (companyDescription, jobDescription, qualifications, additionalInformation), `applyUrl`, `postingUrl`, `active`, `visibility`, `releasedDate`. |
| Detectar cierre | SÍ | 19-oct-2026 | postingId inexistente → HTTP 404 con `code: "RESOURCE_NOT_FOUND"`. El detalle incluye el flag `active`. |
| URL de aplicación | SÍ | 19-oct-2026 | `https://jobs.smartrecruiters.com/{company}/{id}-{slug}?oga=true` (campo `applyUrl`). |
| Auto-relleno asistido | NO | — | No probado. |
| Envío | NO | — | La Application API exige credenciales de partner (OAuth o `X-SmartToken`) que JOBFORCE no tiene. |

## Workday — `{tenant}.wd{N}.myworkdayjobs.com` (público, sin autenticación)

Validado en vivo el **19-oct-2026** con tenant `nvidia`, `wd5`, site `NVIDIAExternalCareerSite`:

| Capacidad | Probado | Fecha | Notas / evidencia |
|---|---|---|---|
| Descubrir ofertas | SÍ | 19-oct-2026 | `POST /wday/cxs/{tenant}/{site}/jobs` con `{"appliedFacets":{},"limit":20,"offset":0,"searchText":""}` → HTTP 200, `total: 2000`, 20 postings por página. **Límites observados**: `limit` máximo efectivo 20; `total` solo en la primera página; tope de 2000 resultados (partir por facetas si hace falta más). Las fechas del listado son texto ("Posted Today"). |
| Detalle de oferta | SÍ | 19-oct-2026 | `GET {base}/job{externalPath}` → HTTP 200 con `jobPostingInfo`: `jobDescription` (HTML), `postedOn`, `startDate` (fecha real), `jobReqId`, `canApply`, `endDate`, `country`. |
| Detectar cierre | SÍ | 19-oct-2026 | Job inexistente → HTTP 404 con mensaje "not found". |
| URL de aplicación | SÍ | 19-oct-2026 | Página pública `https://{tenant}.wd{N}.myworkdayjobs.com/{site}/job{externalPath}`; el apply ocurre dentro de la sesión del candidato (no hay endpoint público de envío). |
| Auto-relleno asistido | NO | — | No probado. |
| Envío | NO | — | Requiere sesión de candidato en Workday. |

## Greenhouse — `boards-api.greenhouse.io` (Job Board API pública, sin clave)

| Capacidad | Probado | Fecha | Notas / evidencia |
|---|---|---|---|
| Descubrir ofertas | SÍ | 18-oct-2026 (Fase 0) y 19-oct-2026 | Fase 0: job board de Stripe renderizado con Playwright (731 ofertas, capturas en `fase0/evidencias/`). 19-oct-2026: `GET /v1/boards/stripe/jobs` → HTTP 200, 725 ofertas con `absolute_url`. |
| Detalle de oferta | SÍ | 19-oct-2026 | `GET /v1/boards/stripe/jobs/{id}?content=true` → HTTP 200 con la descripción completa. |
| Detectar cierre | SÍ | 19-oct-2026 | Job id inexistente → HTTP 404. |
| URL de aplicación | SÍ | 19-oct-2026 | Campo `absolute_url` (p. ej. `https://stripe.com/jobs/search?gh_jid=...`). |
| Auto-relleno asistido | NO | — | Previsto en el plan de fases; no probado. |
| Envío | NO | — | No probado. |

## Lever — `api.lever.co` (público, sin clave)

| Capacidad | Probado | Fecha | Notas / evidencia |
|---|---|---|---|
| Descubrir ofertas | SÍ | 19-oct-2026 | `GET /v0/postings/palantir?mode=json` → HTTP 200, array plano. **La descripción ya viene en el listado** (`description`, `descriptionPlain`). |
| Detalle de oferta | SÍ | 19-oct-2026 | Incluido en el propio listado (no hace falta segunda petición). |
| Detectar cierre | SÍ | 19-oct-2026 | Slug de empresa inexistente → HTTP 404. |
| URL de aplicación | SÍ | 19-oct-2026 | Campos `hostedUrl` / `applyUrl` de cada posting. |
| Auto-relleno asistido | NO | — | No probado. |
| Envío | NO | — | No probado. |

## Personio — portal propio de cada empresa (vía Playwright)

| Capacidad | Probado | Fecha | Notas / evidencia |
|---|---|---|---|
| Descubrir ofertas | Parcial | 19-oct-2026 | La oferta objetivo (HomeToGo, Berlín) llegó vía campaña Exa; la **vigencia se verificó** con Playwright (HTTP 200, sin señales de cierre) antes de generar documentos. Personio no expone un listado público genérico: cada empresa tiene su portal (`{empresa}.jobs.personio.com`). |
| Detalle de oferta | SÍ | 19-oct-2026 | Leído con Playwright del portal oficial. |
| Detectar cierre | SÍ | 19-oct-2026 | Verificación de apertura: página accesible y botón de apply habilitado (en la Fase 3 se descartó antes una oferta de talentmate.com por estar cerrada). |
| URL de aplicación | SÍ | 19-oct-2026 | `https://hometogo.jobs.personio.com/job/2818906/apply?language=nul`. |
| Auto-relleno asistido | SÍ | 19-oct-2026 | Formulario rellenado con Playwright, CV y carta subidos, **sin enviar** hasta la aprobación de Jon. |
| Envío | SÍ | 19-oct-2026 | Con la aprobación explícita de Jon ("Apruebo el envío"): un clic en Submit a las 13:26, confirmación "Thank you!" capturada, email de confirmación recibido. Detalle en `fase3/FIN_FASE3.md`. |

## Notas transversales

- **Red de esta VM**: el proxy de egress hace interceptación TLS (MITM). Los
  probes se hicieron con el `fetch` nativo de Node usando el proxy del
  entorno (`NODE_USE_ENV_PROXY=1`) y desactivando la verificación de
  certificados **solo en los scripts de probe** (`NODE_TLS_REJECT_UNAUTHORIZED=0`).
  En producción ese flag no debe usarse. El patrón del forwarder local de
  `~/AGENTS.md` se probó pero rompía el TLS en este caso; la vía directa con
  las credenciales en variables de entorno funcionó.
- **Política de envío**: ningún conector de este paquete envía candidaturas.
  El envío solo ocurre con aprobación explícita de Jon, como en la Fase 3.
