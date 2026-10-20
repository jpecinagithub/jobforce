/**
 * @jobforce/backend — Configuración automática del formulario (Fase 8.1).
 *
 * Al preparar una candidatura de Personio se intenta construir
 * `offer_snapshot.formConfig` SIN intervención de Jon:
 *
 *   1. Se abre la página de solicitud con el navegador del backend (mismo
 *      patrón que el driver de envíos: forwarder local + proxy del entorno
 *      + certificado tolerado) y se extraen los campos del formulario.
 *   2. Cada campo se casa con (a) hechos del perfil activo o (b) la memoria
 *      de respuestas guardadas reutilizables (`reuse_rule = 'reuse'`).
 *      Los campos estándar de Personio parten de `camposPersonioEstandar`.
 *   3. Si queda algún campo REQUERIDO sin casar, NO se escribe formConfig:
 *      se registra `formConfigPendiente` en el snapshot y se abre una
 *      intervención `datos_desconocidos` con los campos que faltan.
 *
 * PROHIBIDO inventar valores: todo valor sale del perfil o de las
 * respuestas guardadas de Jon. Los checkboxes/radio (consentimientos) no
 * se marcan solos: si son requeridos, la candidatura queda pendiente.
 *
 * La inspección es inyectable (tests). Fuera de producción
 * (`NODE_ENV != production`) sin inyección no se navega nunca: el intento
 * se omite sin tocar el snapshot.
 */

import { query } from '@jobforce/database';
import { auditEvent } from './audit.js';
import { crearIntervencionSiNoAbierta } from './intervention.js';
import {
  cargarPlaywright,
  resolveChromiumExe,
  startForwarder,
} from './sender/driver.js';
import type { CampoFormulario } from './sender/types.js';

// ---------------------------------------------------------------------------
// Tipos de inspección.
// ---------------------------------------------------------------------------

export interface CampoDetectado {
  /** Selector CSS utilizable por el driver (`#id` o `[name="…"]`). */
  selector: string;
  /** id HTML crudo (para reconocer los campos estándar de Personio). */
  idHtml: string | null;
  /** Tipo: 'text', 'email', 'tel', 'select', 'textarea', 'file', 'checkbox'… */
  tipoHtml: string;
  /** Etiqueta visible del campo (label/aria/placeholder), tal cual. */
  etiqueta: string;
  requerido: boolean;
  /** Opciones visibles cuando es un select. */
  opciones?: string[];
}

export interface InspeccionFormulario {
  /** URL donde se encontró el formulario (puede ser la de `/apply`). */
  urlFinal: string;
  campos: CampoDetectado[];
  submitButtonName: string | null;
}

export type InspectorFormulario = (url: string) => Promise<InspeccionFormulario>;

// ---------------------------------------------------------------------------
// Dependencias inyectables (solo tests).
// ---------------------------------------------------------------------------

interface FormConfigTestDeps {
  inspector?: InspectorFormulario;
}

let testDeps: FormConfigTestDeps = {};

/** Solo para tests: sustituye el inspector de formularios por un doble. */
export function setFormConfigTestDeps(deps: FormConfigTestDeps): void {
  testDeps = deps;
}

/** Restaura el inspector real tras un test con dobles. */
export function resetFormConfigTestDeps(): void {
  testDeps = {};
}

// ---------------------------------------------------------------------------
// Inspección real con el navegador del backend.
// ---------------------------------------------------------------------------

const EXTRAER_CAMPOS_JS = `() => {
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const labelDe = (el) => {
    if (el.id) {
      const l = document.querySelector('label[for="' + el.id.replace(/"/g, '') + '"]');
      if (l && l.innerText) return l.innerText.trim();
    }
    const wrap = el.closest('label');
    if (wrap && wrap.innerText) return wrap.innerText.trim();
    return (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '').trim();
  };
  const campos = [];
  for (const el of document.querySelectorAll('input, select, textarea')) {
    const tipo = el.tagName === 'SELECT' ? 'select'
      : el.tagName === 'TEXTAREA' ? 'textarea'
      : (el.getAttribute('type') || 'text').toLowerCase();
    if (['hidden', 'submit', 'button', 'image', 'reset'].includes(tipo)) continue;
    if (!visible(el) && tipo !== 'file') continue;
    const selector = el.id ? '#' + el.id : (el.getAttribute('name') ? '[name="' + el.getAttribute('name') + '"]' : null);
    if (!selector) continue;
    const etiqueta = labelDe(el).replace(/\\s+/g, ' ').slice(0, 200);
    const requerido = !!(el.required || el.getAttribute('aria-required') === 'true' || /\\*\\s*$/.test(etiqueta));
    const campo = { selector, idHtml: el.id || null, tipoHtml: tipo, etiqueta, requerido };
    if (tipo === 'select') {
      campo.opciones = [...el.options].map((o) => (o.text || '').trim()).filter(Boolean).slice(0, 60);
    }
    campos.push(campo);
  }
  let submitButtonName = null;
  for (const b of document.querySelectorAll('button, input[type="submit"]')) {
    const t = (b.innerText || b.value || '').trim().replace(/\\s+/g, ' ');
    if (/submit|send application|apply|bewerbung absenden|absenden|enviar/i.test(t)) { submitButtonName = t.slice(0, 80); break; }
  }
  return { campos, submitButtonName };
}`;

interface PaginaInspeccion {
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  evaluate<T>(fn: string): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
}

/**
 * Inspector real: abre la URL de la oferta; si no aparece ningún campo y la
 * URL no es ya la de solicitud, prueba con `/apply` (convención Personio).
 */
export const inspeccionarFormularioPersonio: InspectorFormulario = async (url) => {
  const forwarder = await startForwarder();
  const chromium = cargarPlaywright();
  let browser: { newPage(opts?: Record<string, unknown>): Promise<PaginaInspeccion>; close(): Promise<void> } | null =
    null;
  try {
    browser = await chromium.launch({
      executablePath: resolveChromiumExe(),
      headless: true,
      ...(forwarder ? { proxy: { server: 'http://127.0.0.1:18080' } } : {}),
      args: ['--ignore-certificate-errors', '--no-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
    const intentar = async (u: string): Promise<InspeccionFormulario> => {
      await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(3500);
      // IIFE: un string con la función a secas NO se invoca al evaluarlo
      // (Playwright devuelve undefined); la expresión debe llamarla.
      const r = await page.evaluate<{ campos: CampoDetectado[]; submitButtonName: string | null }>(
        `(${EXTRAER_CAMPOS_JS})()`,
      );
      return { urlFinal: u, campos: r?.campos ?? [], submitButtonName: r?.submitButtonName ?? null };
    };
    let resultado = await intentar(url);
    if (resultado.campos.length === 0 && !/\/apply(\?|$)/i.test(url)) {
      const conApply = `${url.replace(/\/$/, '')}/apply`;
      const segundo = await intentar(conApply);
      if (segundo.campos.length > 0) resultado = segundo;
    }
    return resultado;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (forwarder) forwarder.close();
  }
};

function inspectorEfectivo(deps?: { inspector?: InspectorFormulario }): InspectorFormulario | null {
  if (deps?.inspector) return deps.inspector;
  if (testDeps.inspector) return testDeps.inspector;
  // Fail-safe: el inspector real SOLO se usa en producción (el contenedor
  // fija NODE_ENV=production). En cualquier otro entorno sin doble
  // inyectado no se navega: la preparación no debe depender de la red ni
  // de Chromium para ser determinista.
  if (process.env.NODE_ENV !== 'production') return null;
  return inspeccionarFormularioPersonio;
}

// ---------------------------------------------------------------------------
// Casado de campos: perfil + memoria de respuestas.
// ---------------------------------------------------------------------------

export function normalizarTexto(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface DatosCandidato {
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  city: string | null;
  country: string | null;
  linkedin: string | null;
}

export interface RespuestaGuardada {
  preguntaNormalizada: string;
  respuesta: string;
}

/** Conceptos del perfil con sus sinónimos (ES/EN/DE) en etiquetas de formulario. */
const CONCEPTOS: Array<{ clave: keyof DatosCandidato; sinonimos: string[] }> = [
  { clave: 'firstName', sinonimos: ['first name', 'given name', 'nombre', 'vorname'] },
  { clave: 'lastName', sinonimos: ['last name', 'surname', 'family name', 'apellidos', 'apellido', 'nachname', 'familienname'] },
  { clave: 'email', sinonimos: ['email', 'e mail', 'correo electronico', 'correo', 'e mail adresse'] },
  { clave: 'phone', sinonimos: ['phone', 'phone number', 'telefono', 'mobile', 'mobile number', 'telefonnummer', 'telefon', 'handy', 'cell phone'] },
  { clave: 'linkedin', sinonimos: ['linkedin', 'linkedin profile', 'linkedin url', 'perfil de linkedin'] },
  { clave: 'city', sinonimos: ['city', 'ciudad', 'ort', 'place of residence', 'ciudad de residencia'] },
  { clave: 'country', sinonimos: ['country', 'pais', 'land'] },
  { clave: 'location', sinonimos: ['location', 'ubicacion', 'current location', 'residence', 'wohnort', 'direccion', 'address'] },
  { clave: 'fullName', sinonimos: ['full name', 'name', 'nombre completo', 'vollstandiger name'] },
];

/** Ids estándar de Personio → concepto (aunque la etiqueta varíe). */
const IDS_PERSONIO: Array<{ patron: RegExp; clave: keyof DatosCandidato }> = [
  { patron: /first_name/, clave: 'firstName' },
  { patron: /last_name/, clave: 'lastName' },
  { patron: /email/, clave: 'email' },
  { patron: /phone/, clave: 'phone' },
];

function conceptoDeCampo(campo: CampoDetectado): keyof DatosCandidato | null {
  if (campo.idHtml) {
    for (const { patron, clave } of IDS_PERSONIO) {
      if (patron.test(campo.idHtml)) return clave;
    }
  }
  const etiqueta = normalizarTexto(campo.etiqueta);
  if (!etiqueta) return null;
  // Los sinónimos más largos primero: 'phone number' antes que 'name', etc.
  const ordenados = [...CONCEPTOS].sort(
    (a, b) =>
      Math.max(...b.sinonimos.map((s) => s.length)) - Math.max(...a.sinonimos.map((s) => s.length)),
  );
  for (const { clave, sinonimos } of ordenados) {
    if (sinonimos.some((s) => etiqueta === s || etiqueta.startsWith(`${s} `) || etiqueta.endsWith(` ${s}`) || etiqueta.includes(s))) {
      return clave;
    }
  }
  return null;
}

function respuestaParaCampo(
  campo: CampoDetectado,
  respuestas: RespuestaGuardada[],
): string | null {
  const etiqueta = normalizarTexto(campo.etiqueta);
  if (etiqueta.length < 4) return null;
  for (const r of respuestas) {
    const pregunta = normalizarTexto(r.preguntaNormalizada);
    if (pregunta.length < 4) continue;
    if (etiqueta === pregunta || etiqueta.includes(pregunta) || pregunta.includes(etiqueta)) {
      return r.respuesta;
    }
    // Solape total de tokens significativos de la pregunta en la etiqueta.
    const tokens = pregunta.split(' ').filter((t) => t.length > 3);
    if (tokens.length >= 2 && tokens.every((t) => etiqueta.split(' ').includes(t))) {
      return r.respuesta;
    }
  }
  return null;
}

export interface FormConfigGenerado {
  applyUrl: string;
  campos: CampoFormulario[];
  docCvSelector: string;
  docCartaSelector: string;
  submitButtonName: string;
}

export interface ResultadoMapeo {
  formConfig: FormConfigGenerado;
  /** Etiquetas de campos REQUERIDOS que no se pudieron casar. */
  sinMapearRequeridos: string[];
}

/**
 * Casa los campos detectados con el perfil y las respuestas. Devuelve el
 * formConfig candidato y la lista de requeridos sin casar (si no está vacía,
 * el llamante NO debe persistir el formConfig).
 */
export function mapearCampos(
  inspeccion: InspeccionFormulario,
  datos: DatosCandidato,
  respuestas: RespuestaGuardada[],
): ResultadoMapeo {
  const campos: CampoFormulario[] = [];
  const sinMapearRequeridos: string[] = [];
  let docCvSelector: string | null = null;
  let docCartaSelector: string | null = null;

  for (const campo of inspeccion.campos) {
    // Ficheros: alimentan los selectores de documentos, no `campos`.
    if (campo.tipoHtml === 'file') {
      const pista = normalizarTexto(`${campo.idHtml ?? ''} ${campo.etiqueta}`);
      if (/cover|anschreiben|carta/.test(pista)) {
        docCartaSelector ??= campo.selector;
      } else if (/cv|resume|lebenslauf|curriculum/.test(pista)) {
        docCvSelector ??= campo.selector;
      } else if (campo.requerido) {
        sinMapearRequeridos.push(campo.etiqueta || campo.selector);
      }
      continue;
    }
    // Consentimientos y controles no rellenables: nunca se marcan solos.
    if (['checkbox', 'radio'].includes(campo.tipoHtml)) {
      if (campo.requerido) sinMapearRequeridos.push(campo.etiqueta || campo.selector);
      continue;
    }

    // 1) Concepto del perfil; 2) memoria de respuestas.
    let valor: string | null = null;
    const concepto = conceptoDeCampo(campo);
    if (concepto) {
      const v = datos[concepto];
      if (typeof v === 'string' && v.trim() !== '') valor = v;
    }
    if (valor === null) {
      valor = respuestaParaCampo(campo, respuestas);
    }

    if (valor === null) {
      if (campo.requerido) sinMapearRequeridos.push(campo.etiqueta || campo.selector);
      continue;
    }

    if (campo.tipoHtml === 'select') {
      // El driver selecciona por etiqueta visible: el valor debe ser una
      // de las opciones REALES del select.
      const opciones = campo.opciones ?? [];
      const elegida = opciones.find((o) => normalizarTexto(o) === normalizarTexto(valor!));
      if (!elegida) {
        if (campo.requerido) sinMapearRequeridos.push(campo.etiqueta || campo.selector);
        continue;
      }
      campos.push({ selector: campo.selector, tipo: 'select', valor: elegida, etiqueta: campo.etiqueta || campo.selector });
    } else {
      campos.push({ selector: campo.selector, tipo: 'fill', valor, etiqueta: campo.etiqueta || campo.selector });
    }
  }

  // Los campos estándar de Personio (#field-first_name, …) ya quedaron
  // casados por id en el bucle; la forma resultante coincide con la de
  // `camposPersonioEstandar` del driver (mismos selectores y valores).
  return {
    formConfig: {
      applyUrl: inspeccion.urlFinal,
      campos,
      docCvSelector: docCvSelector ?? '#doc-input-cv',
      docCartaSelector: docCartaSelector ?? '#doc-input-cover-letter',
      submitButtonName: inspeccion.submitButtonName ?? 'submit application',
    },
    sinMapearRequeridos,
  };
}

// ---------------------------------------------------------------------------
// Carga de datos (perfil activo + respuestas reutilizables).
// ---------------------------------------------------------------------------

function asStr(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

async function cargarDatosCandidato(): Promise<DatosCandidato | null> {
  const versions = await query<{ id: string }>(
    `SELECT id FROM profile_versions WHERE status = 'active' ORDER BY version_no DESC LIMIT 1`,
  );
  if (versions.length === 0) return null;
  const facts = await query<{ category: string; key: string; value: unknown }>(
    `SELECT category, key, value FROM profile_facts WHERE profile_version_id = $1`,
    [versions[0].id],
  );
  const get = (key: string) => facts.find((f) => f.category === 'identity' && f.key === key)?.value;
  const fullName = asStr(get('full_name'));
  if (!fullName) return null;
  const partes = fullName.trim().split(/\s+/);
  const locRaw = get('location');
  let city: string | null = null;
  let country: string | null = null;
  let location: string | null = null;
  if (typeof locRaw === 'object' && locRaw !== null && !Array.isArray(locRaw)) {
    const o = locRaw as Record<string, unknown>;
    city = asStr(o.city);
    country = asStr(o.country);
    location = [city, country].filter(Boolean).join(', ') || null;
  } else {
    location = asStr(locRaw);
  }
  return {
    firstName: partes[0] ?? null,
    lastName: partes.length > 1 ? partes.slice(1).join(' ') : null,
    fullName,
    email: asStr(get('email')),
    phone: asStr(get('phone')),
    location,
    city,
    country,
    linkedin: asStr(get('linkedin')),
  };
}

async function cargarRespuestasReutilizables(empresa: string | null): Promise<RespuestaGuardada[]> {
  const rows = await query<{
    question_normalized: string;
    answer: string;
    scope_type: string;
    scope_value: string | null;
  }>(
    `SELECT question_normalized, answer, scope_type, scope_value
       FROM answer_memory
      WHERE reuse_rule = 'reuse'
        AND (valid_from IS NULL OR valid_from <= CURRENT_DATE)
        AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)`,
  );
  return rows
    .filter((r) => {
      if (r.scope_type === 'general') return true;
      // Ámbito de empresa: solo si es ESTA empresa. Otros ámbitos
      // (posición/candidatura) no se aplican solos: demasiado específicos.
      if (r.scope_type === 'company' && empresa && r.scope_value) {
        return normalizarTexto(r.scope_value) === normalizarTexto(empresa);
      }
      return false;
    })
    .map((r) => ({ preguntaNormalizada: r.question_normalized, respuesta: r.answer }));
}

// ---------------------------------------------------------------------------
// Intento de configuración sobre una candidatura (orquestación con BD).
// ---------------------------------------------------------------------------

export type ResultadoIntentoFormConfig =
  | { estado: 'ok'; formConfig: FormConfigGenerado }
  | { estado: 'pendiente'; motivo: string; camposSinMapear: string[] }
  | { estado: 'no_aplica'; motivo: 'portal_sin_driver' }
  | { estado: 'error'; motivo: string }
  | { estado: 'omitido'; motivo: string };

interface ApplicationFormRow {
  id: string;
  portal: string | null;
  offer_snapshot: Record<string, unknown>;
  offer_url: string | null;
  offer_company: string | null;
}

async function guardarPendiente(
  applicationId: string,
  pendiente: { motivo: string; camposSinMapear?: string[] },
  yaTieneFormConfig: boolean,
): Promise<void> {
  if (yaTieneFormConfig) return; // Nunca degradar un formConfig válido.
  await query(
    `UPDATE applications
        SET offer_snapshot = offer_snapshot || $2::jsonb, updated_at = now()
      WHERE id = $1`,
    [
      applicationId,
      JSON.stringify({
        formConfigPendiente: {
          motivo: pendiente.motivo,
          ...(pendiente.camposSinMapear ? { camposSinMapear: pendiente.camposSinMapear } : {}),
          en: new Date().toISOString(),
        },
      }),
    ],
  );
}

/**
 * Intenta construir el formConfig de una candidatura. Nunca lanza: la
 * preparación de la candidatura no depende de este paso.
 */
export async function intentarConfigurarFormulario(
  applicationId: string,
  deps: { inspector?: InspectorFormulario } = {},
): Promise<ResultadoIntentoFormConfig> {
  const rows = await query<ApplicationFormRow>(
    `SELECT a.id, a.portal, a.offer_snapshot, o.url AS offer_url, o.company AS offer_company
       FROM applications a JOIN offers o ON o.id = a.offer_id
      WHERE a.id = $1`,
    [applicationId],
  );
  const app = rows[0];
  if (!app) return { estado: 'error', motivo: 'candidatura_no_encontrada' };
  const yaTieneFormConfig =
    typeof app.offer_snapshot?.formConfig === 'object' && app.offer_snapshot.formConfig !== null;

  if ((app.portal ?? '').trim().toLowerCase() !== 'personio') {
    await guardarPendiente(applicationId, { motivo: 'portal_sin_driver' }, yaTieneFormConfig);
    return { estado: 'no_aplica', motivo: 'portal_sin_driver' };
  }
  if (!app.offer_url) {
    return { estado: 'error', motivo: 'sin_url_de_oferta' };
  }
  const inspector = inspectorEfectivo(deps);
  if (!inspector) {
    return { estado: 'omitido', motivo: 'inspector_no_disponible_en_este_entorno' };
  }

  let inspeccion: InspeccionFormulario;
  try {
    inspeccion = await inspector(app.offer_url);
    if (!inspeccion.campos || inspeccion.campos.length === 0) {
      // Una página sin ningún campo no es un formulario utilizable: se
      // trata como inspección fallida, jamás como formConfig vacío.
      throw new Error('la inspección no detectó ningún campo de formulario');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'error desconocido';
    await guardarPendiente(
      applicationId,
      { motivo: `inspeccion_fallida: ${msg}`.slice(0, 500) },
      yaTieneFormConfig,
    );
    await auditEvent({
      actorId: null,
      action: 'form_config_inspection_failed',
      entityType: 'application',
      entityId: applicationId,
      details: { error: msg.slice(0, 500) },
    });
    return { estado: 'error', motivo: `inspeccion_fallida: ${msg}` };
  }

  const datos = await cargarDatosCandidato();
  if (!datos) {
    await guardarPendiente(applicationId, { motivo: 'sin_perfil_activo_o_incompleto' }, yaTieneFormConfig);
    return { estado: 'error', motivo: 'sin_perfil_activo_o_incompleto' };
  }
  const respuestas = await cargarRespuestasReutilizables(app.offer_company);
  const { formConfig, sinMapearRequeridos } = mapearCampos(inspeccion, datos, respuestas);

  if (sinMapearRequeridos.length > 0) {
    await guardarPendiente(
      applicationId,
      { motivo: 'campos_requeridos_sin_mapear', camposSinMapear: sinMapearRequeridos },
      yaTieneFormConfig,
    );
    await crearIntervencionSiNoAbierta('datos_desconocidos', applicationId, {
      origen: 'formconfig_automatico',
      motivo: 'campos_requeridos_sin_mapear',
      camposSinMapear: sinMapearRequeridos,
      detalle:
        'El formulario del portal pide datos que no están en el perfil ni en las respuestas guardadas. Sin ellos no se configura el envío automático.',
    });
    await auditEvent({
      actorId: null,
      action: 'form_config_pending',
      entityType: 'application',
      entityId: applicationId,
      details: { camposSinMapear: sinMapearRequeridos },
    });
    return { estado: 'pendiente', motivo: 'campos_requeridos_sin_mapear', camposSinMapear: sinMapearRequeridos };
  }

  await query(
    `UPDATE applications
        SET offer_snapshot = (offer_snapshot - 'formConfigPendiente') || $2::jsonb,
            updated_at = now()
      WHERE id = $1`,
    [applicationId, JSON.stringify({ formConfig })],
  );
  await auditEvent({
    actorId: null,
    action: 'form_config_generated',
    entityType: 'application',
    entityId: applicationId,
    details: { campos: formConfig.campos.length, applyUrl: formConfig.applyUrl },
  });
  return { estado: 'ok', formConfig };
}
