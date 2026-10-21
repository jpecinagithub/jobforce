/**
 * Driver de navegador para Workday (portales *.wdN.myworkdayjobs.com).
 *
 * Encargo de Jon (2026-10-21): el agente debe aprender los portales de
 * empresa empezando por Workday — crear la cuenta con SU email y SU
 * contraseña (guardada cifrada en `portal_accounts`, nunca en claro) y
 * completar la candidatura hasta el final. Flujo verificado en vivo
 * con CLR (Continental Resources, R02656): job → «Apply» → panel
 * «Start Your Application» → «Autofill with Resume» → asistente de 8
 * pasos: 1 Create Account/Sign In, 2 Autofill with Resume,
 * 3 My Information, 4 My Experience, 5-6 Application Questions,
 * 7 Voluntary Disclosures, 8 Review → Submit.
 *
 * Motor genérico por pasos: en cada paso descubre los campos visibles
 * con su etiqueta (label[for], aria-label, data-automation-id
 * humanizado) y responde SOLO lo determinable desde el perfil:
 *  - Datos de contacto/dirección desde `DatosEtiquetas`.
 *  - Autorización de trabajo: veraz según el país del puesto (leído del
 *    encabezado de la oferta): SÍ solo en España/UE; patrocinio =
 *    lo contrario. Sueldo: el hecho del perfil, o parada nombrándola.
 *  - «Voluntary Disclosures» (EEO): se elige la opción de no declarar
 *    («Decline / I don't wish to answer») cuando existe.
 *  - Cualquier otro campo obligatorio sin respuesta determinada:
 *    parada `datos_ausentes` nombrando el campo/la pregunta exactos.
 * Los desplegables de Workday (prompts) se resuelven por texto exacto.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { cargarPlaywright, resolveChromiumExe, startForwarder } from './driver.js';
import {
  AnomaliaEnvio,
  type AperturaResultado,
  type BrowserDriver,
  type DriverJob,
  type PreparacionResultado,
  type ResultadoDriver,
} from './types.js';

interface PwFrame {
  url(): string;
  evaluate<R>(fn: string): Promise<R>;
  $(selector: string): Promise<unknown>;
  click(selector: string, opts?: { timeout?: number }): Promise<void>;
  fill(selector: string, value: string, opts?: { timeout?: number }): Promise<void>;
  selectOption(selector: string, value: { label: string }): Promise<string[]>;
  setInputFiles(selector: string, files: string | string[]): Promise<void>;
}

interface PwPage extends PwFrame {
  getByRole(
    role: string,
    opts?: { name: RegExp },
  ): { first(): { click(): Promise<void>; isVisible(): Promise<boolean> } };
  goto(
    url: string,
    opts?: { waitUntil?: string; timeout?: number },
  ): Promise<{ status(): number } | null>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(opts: { path: string; fullPage?: boolean }): Promise<void>;
  frames(): PwFrame[];
}

interface PwBrowser {
  newPage(opts?: Record<string, unknown>): Promise<PwPage>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Descubrimiento de campos del paso actual (marco principal).
// ---------------------------------------------------------------------------

interface CampoWD {
  sel: string;
  tipo: string; // text|email|tel|textarea|select|radio|checkbox|file|desplegable|date|number
  etiqueta: string;
  grupo: string; // pregunta (radios/checkbox)
  requerido: boolean;
  valor: string;
  opciones: string[]; // radios: textos de las opciones del grupo (una fila por grupo)
}

const DESCUBRIR_JS = `(function () {
  function texto(el) { return (el.textContent || '').replace(/\\s+/g, ' ').trim(); }
  function visible(el) { return !!(el.offsetWidth || el.offsetHeight); }
  function humanizar(aid) {
    return (aid || '').replace(/^.*?--/, '').replace(/[-_]+/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  }
  function etiquetaDe(e) {
    if (e.id) {
      var l = document.querySelector('label[for="' + CSS.escape(e.id) + '"]');
      if (l && texto(l)) return texto(l);
    }
    var al = e.getAttribute('aria-label');
    if (al && al.trim()) return al.trim();
    var nodo = e;
    for (var k = 0; k < 6 && nodo.parentElement; k++) {
      nodo = nodo.parentElement;
      if (!nodo.querySelector) continue;
      var lab = nodo.querySelector('label, legend');
      if (lab && texto(lab)) return texto(lab);
      var primer = nodo.children && nodo.children[0];
      if (primer && primer !== e && texto(primer) && texto(primer).length <= 80 && !primer.querySelector('input, select, textarea, button')) {
        return texto(primer);
      }
    }
    var aid = e.getAttribute('data-automation-id') || '';
    if (aid) return humanizar(aid);
    return e.getAttribute('placeholder') || e.name || '';
  }
  function selectorDe(e) {
    if (e.id) return '#' + CSS.escape(e.id);
    var aid = e.getAttribute('data-automation-id');
    if (aid) return '[data-automation-id="' + aid + '"]';
    if (e.name) return e.tagName.toLowerCase() + '[name="' + e.name + '"]';
    return '';
  }
  function requeridoDe(e, etiqueta) {
    if (e.getAttribute('aria-required') === 'true' || e.required) return true;
    if (/\\*/.test(etiqueta)) return true;
    var nodo = e;
    for (var k = 0; k < 4 && nodo.parentElement; k++) {
      nodo = nodo.parentElement;
      if (nodo.getAttribute && nodo.getAttribute('aria-required') === 'true') return true;
    }
    return false;
  }
  var out = [];
  var radiosVistos = {};
  var nodes = document.querySelectorAll('input, select, textarea, button[aria-haspopup="listbox"], [role="combobox"]');
  for (var i = 0; i < nodes.length; i++) {
    var e = nodes[i];
    var tag = e.tagName.toLowerCase();
    var tipo = tag === 'button' || e.getAttribute('role') === 'combobox'
      ? 'desplegable'
      : (e.getAttribute('type') || tag).toLowerCase();
    if (tipo === 'hidden' || tipo === 'submit' || tipo === 'button' && tag !== 'button') continue;
    if (tag === 'button' && e.getAttribute('aria-haspopup') !== 'listbox') continue;
    if (!visible(e)) continue;
    var etiqueta = etiquetaDe(e);
    if (tipo === 'radio') {
      var grupo = e.name || etiqueta;
      if (radiosVistos[grupo]) continue;
      radiosVistos[grupo] = true;
      var opciones = [];
      var delGrupo = document.querySelectorAll('input[type="radio"][name="' + CSS.escape(e.name) + '"]');
      for (var j = 0; j < delGrupo.length; j++) {
        var r = delGrupo[j];
        var lab = (r.id && document.querySelector('label[for="' + CSS.escape(r.id) + '"]')) ||
          r.closest('label');
        opciones.push(lab ? texto(lab) : (r.value || ''));
      }
      // La pregunta: ancestro con texto propio descontando las opciones.
      var pregunta = etiqueta;
      var fs = e.closest('fieldset');
      if (fs) {
        var lg = fs.querySelector('legend');
        if (lg && texto(lg)) pregunta = texto(lg);
      }
      out.push({
        sel: 'input[type="radio"][name="' + e.name + '"]',
        tipo: 'radio', etiqueta: pregunta, grupo: pregunta,
        requerido: requeridoDe(e, pregunta),
        valor: (function () {
          for (var m = 0; m < delGrupo.length; m++) if (delGrupo[m].checked) {
            var l2 = (delGrupo[m].id && document.querySelector('label[for="' + CSS.escape(delGrupo[m].id) + '"]')) || delGrupo[m].closest('label');
            return l2 ? texto(l2) : delGrupo[m].value;
          }
          return '';
        })(),
        opciones: opciones,
      });
      continue;
    }
    var valor = '';
    if (tipo === 'desplegable') valor = texto(e) || (e.value || '');
    else if (tipo === 'checkbox') valor = e.checked ? 'on' : '';
    else if (tipo === 'select') {
      var opt = e.options && e.selectedIndex >= 0 ? e.options[e.selectedIndex] : null;
      valor = opt ? (opt.text || '').trim() : '';
      var ops = [];
      if (e.options) for (var q = 0; q < e.options.length; q++) ops.push((e.options[q].text || '').trim());
      out.push({ sel: selectorDe(e), tipo: tipo, etiqueta: etiqueta, grupo: etiqueta, requerido: requeridoDe(e, etiqueta), valor: valor, opciones: ops });
      continue;
    } else valor = e.value || '';
    out.push({
      sel: selectorDe(e), tipo: tipo, etiqueta: etiqueta, grupo: etiqueta,
      requerido: requeridoDe(e, etiqueta), valor: valor, opciones: [],
    });
  }
  return out;
})()`;

const PASO_JS = `(function () {
  var t = document.body.innerText || '';
  var m = t.match(/current step \\d+ of \\d+\\s*\\n([^\\n]+)/i);
  if (m) return m[1].trim();
  var cur = document.querySelector('[aria-current="step"]');
  if (cur) return (cur.textContent || '').replace(/\\s+/g, ' ').trim();
  return '';
})()`;

const ERRORES_JS = `(function () {
  var out = [];
  var widgets = document.querySelectorAll('[data-automation-id="errorWidget"], [role="alert"], [data-automation-id="toastMessage"]');
  for (var i = 0; i < widgets.length; i++) {
    var t = (widgets[i].textContent || '').replace(/\\s+/g, ' ').trim();
    if (t) out.push(t.slice(0, 300));
  }
  var invalidos = document.querySelectorAll('[aria-invalid="true"]');
  for (var j = 0; j < invalidos.length && out.length < 5; j++) {
    var e = invalidos[j];
    var lab = '';
    if (e.id) { var l = document.querySelector('label[for="' + CSS.escape(e.id) + '"]'); if (l) lab = (l.textContent || '').trim(); }
    if (lab) out.push('campo inválido: ' + lab);
  }
  return out;
})()`;

const CLICK_TEXTO_JS = `(function (textos) {
  function norm(s) { return (s || '').replace(/\\s+/g, ' ').trim().toLowerCase(); }
  var els = document.querySelectorAll('a, button, [role="button"]');
  for (var i = 0; i < els.length; i++) {
    var e = els[i];
    if (!(e.offsetWidth || e.offsetHeight)) continue;
    var t = norm(e.textContent);
    for (var k = 0; k < textos.length; k++) {
      if (t === textos[k]) { e.scrollIntoView({block: 'center'}); e.click(); return e.textContent.trim(); }
    }
  }
  return null;
})`;

const MARCAR_RADIO_JS = `(function (args) {
  var inputs = document.querySelectorAll('input[type="radio"][name="' + CSS.escape(args.name) + '"]');
  function norm(s) { return (s || '').replace(/\\s+/g, ' ').trim().toLowerCase(); }
  for (var i = 0; i < inputs.length; i++) {
    var r = inputs[i];
    var lab = (r.id && document.querySelector('label[for="' + CSS.escape(r.id) + '"]')) || r.closest('label');
    var t = lab ? norm(lab.textContent) : norm(r.value);
    if (t === norm(args.opcion) || t.indexOf(norm(args.opcion)) === 0) {
      r.click();
      return r.checked ? (lab ? lab.textContent.trim() : r.value) : null;
    }
  }
  return null;
})`;

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** País del puesto desde el texto del encabezado («locations / Oklahoma City, OK»). */
function paisDesdeTexto(texto: string): string {
  const t = texto.slice(0, 2500);
  if (/\b(OK|TX|NY|CA|OH|IL|FL|WA|CO|AZ|GA|NC|VA|MA|PA)\b|united states|u\.s\.a/i.test(t)) return 'US';
  if (/united kingdom|london|\buk\b/i.test(t)) return 'UK';
  if (/spain|españa|madrid|barcelona|logroño/i.test(t)) return 'ES';
  return '';
}

const ZONA_DERECHO = new Set(['ES', 'EU', 'DE', 'FR', 'IT', 'PT', 'NL', 'BE', 'IE', 'AT', 'PL', 'SE', 'DK', 'FI']);

export class WorkdayDriver implements BrowserDriver {
  readonly portal = 'workday';
  private browser: PwBrowser | null = null;
  private page: PwPage | null = null;
  private forwarder: import('node:net').Server | null = null;
  private capturas: string[] = [];
  private paisPuesto = '';

  private async pageActiva(job: DriverJob): Promise<PwPage> {
    if (this.page) return this.page;
    this.forwarder = await startForwarder();
    const chromium = cargarPlaywright();
    const browser = (await chromium.launch({
      executablePath: resolveChromiumExe(),
      headless: true,
      ...(this.forwarder ? { proxy: { server: 'http://127.0.0.1:18080' } } : {}),
      args: [
        '--ignore-certificate-errors',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
    })) as unknown as PwBrowser;
    this.browser = browser;
    const page = await browser.newPage({
      viewport: { width: 1360, height: 1100 },
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      locale: 'en-US',
    });
    this.page = page;
    mkdirSync(job.shotsDir, { recursive: true });
    return page;
  }

  async cerrar(): Promise<void> {
    try {
      await this.browser?.close();
    } catch {
      // Ya cerrado.
    }
    this.browser = null;
    this.page = null;
    try {
      this.forwarder?.close();
    } catch {
      // Nada que cerrar.
    }
    this.forwarder = null;
  }

  private async capturar(page: PwPage, job: DriverJob, nombre: string): Promise<string> {
    const ruta = join(job.shotsDir, nombre);
    try {
      await page.screenshot({ path: ruta, fullPage: false });
    } catch {
      // Evidencia, no debe tumbar el flujo.
    }
    this.capturas.push(ruta);
    return ruta;
  }

  private async captchaVisible(page: PwPage): Promise<boolean> {
    for (const f of page.frames()) {
      try {
        const hits = await f.evaluate<number>(
          `[...document.querySelectorAll("iframe")].filter(x => /recaptcha|hcaptcha|turnstile|challenges\\.cloudflare/i.test(x.src || "") && x.offsetParent !== null).length`,
        );
        if (hits > 0) return true;
      } catch {
        // Marco inaccesible: se ignora.
      }
    }
    return false;
  }

  /** clickTexto con reintentos: la SPA pinta el botón con retraso variable. */
  private async esperarClickTexto(
    page: PwPage,
    textos: string[],
    intentos = 10,
    esperaMs = 2000,
  ): Promise<string | null> {
    for (let i = 0; i < intentos; i++) {
      const r = await this.clickTexto(page, textos).catch(() => null);
      if (r) return r;
      await page.waitForTimeout(esperaMs);
    }
    return null;
  }

  private async texto(page: PwPage): Promise<string> {
    return page.evaluate<string>(`(document.body.innerText || '').slice(0, 9000)`).catch(() => '');
  }

  private async clickTexto(page: PwPage, textos: string[]): Promise<string | null> {
    return page.evaluate<string | null>(`${CLICK_TEXTO_JS}(${JSON.stringify(textos.map((t) => t.toLowerCase()))})`);
  }

  /** Espera a que la SPA pinte contenido útil (tras crear la cuenta
   * Workday recarga la página entera y la captura sale en blanco). */
  private async esperarContenido(page: PwPage, intentos = 10): Promise<void> {
    for (let i = 0; i < intentos; i++) {
      const t = await this.texto(page);
      if (t.length > 300) return;
      await page.waitForTimeout(2000);
    }
  }

  /** Abre el panel de aplicación y elige «Autofill with Resume». */
  private async abrirAsistente(page: PwPage, job: DriverJob): Promise<void> {
    await page.goto(job.applyUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);
    const texto = await this.texto(page);
    if (/no longer accepting|position (is|has been) closed|job (is|has been) filled/i.test(texto)) {
      throw new AnomaliaEnvio('oferta_cerrada', 'Workday muestra la oferta cerrada');
    }
    this.paisPuesto = paisDesdeTexto(texto);
    // Cookies: «Decline» no tapa nada y no acepta seguimiento.
    await this.clickTexto(page, ['decline', 'accept cookies']).catch(() => null);
    const apply = await this.esperarClickTexto(page, ['apply', 'apply now']);
    if (!apply) throw new AnomaliaEnvio('formulario_cambiado', 'no se encontró el botón Apply de Workday');
    await page.waitForTimeout(2500);
    const auto = await this.clickTexto(page, ['autofill with resume']);
    if (!auto) {
      const manual = await this.clickTexto(page, ['apply manually']);
      if (!manual) {
        throw new AnomaliaEnvio('formulario_cambiado', 'el panel de Workday no ofrece Autofill ni Apply Manually');
      }
    }
    await page.waitForTimeout(4500);
  }

  async verificarApertura(job: DriverJob): Promise<AperturaResultado> {
    const page = await this.pageActiva(job);
    await page.goto(job.applyUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);
    const texto = await this.texto(page);
    if (/no longer accepting|position (is|has been) closed|job (is|has been) filled/i.test(texto)) {
      return { abierta: false, detalle: 'Workday muestra la oferta cerrada' };
    }
    const apply = await this.esperarClickTexto(page, ['apply', 'apply now']);
    if (!apply) return { abierta: false, detalle: 'sin botón Apply visible en Workday' };
    let panel = '';
    let ok = false;
    for (let i = 0; i < 5 && !ok; i++) {
      await page.waitForTimeout(1800);
      panel = await this.texto(page);
      ok = /start your application|autofill with resume|apply manually/i.test(panel);
    }
    return {
      abierta: ok,
      detalle: ok ? 'panel de aplicación de Workday visible' : 'el panel de aplicación no se abrió',
    };
  }

  // --------------------------------------------------------------------
  // Paso 1: cuenta (crear o entrar) con las credenciales cifradas.
  // --------------------------------------------------------------------
  /**
   * Paso 1 como máquina de estados con sondeo (reescrito tras 5
   * pasadas en vivo contra CLR): Workday tarda ~10 s en pintar el
   * selector social, redirige a la página del portal cuando el alta
   * choca con una cuenta existente, y el contenido del paso a veces
   * llega vacío y tarda en renderizar. Se clasifica la pantalla en
   * cada ronda y se actúa según el estado, con contadores anti-bucle
   * (máx. 1 alta + 1 entrada por ejecución).
   */
  private async pasoCuenta(page: PwPage, job: DriverJob): Promise<void> {
    const datos = job.etiquetas;
    if (!datos?.cuentaEmail || !datos?.cuentaPassword) {
      throw new AnomaliaEnvio('datos_ausentes', 'sin credenciales de cuenta para Workday');
    }
    type Estado =
      | 'otro_paso'
      | 'formulario_crear'
      | 'formulario_entrar'
      | 'selector'
      | 'cargando'
      | 'desconocido';
    const clasificar = async (): Promise<Estado> => {
      return page.evaluate<Estado>(`(function () {
        var texto = document.body.innerText || '';
        var hayStepper = /current step \d+ of \d+/.test(texto);
        var pass = document.querySelectorAll('input[type="password"]');
        var passVisibles = 0;
        for (var i = 0; i < pass.length; i++) if (pass[i].offsetWidth || pass[i].offsetHeight) passVisibles++;
        var m = texto.match(/current step \d+ of \d+\s*\n([^\n]+)/i);
        var paso = m ? m[1].trim().toLowerCase() : '';
        if (hayStepper && paso && !/create account|sign in/.test(paso)) return 'otro_paso';
        if (passVisibles >= 2) return 'formulario_crear';
        if (passVisibles === 1) return 'formulario_entrar';
        if (/sign in with email/i.test(texto)) return 'selector';
        if (hayStepper) return 'cargando';
        return 'desconocido';
      })()`);
    };
    const rellenarYEnviar = async (crear: boolean): Promise<void> => {
      const emailSel = (await page.$('input[type="email"]'))
        ? 'input[type="email"]'
        : 'input[name*="email" i], input[id*="email" i]';
      await page.fill(emailSel, datos.cuentaEmail).catch(() => undefined);
      const n = await page.evaluate<number>(
        `[...document.querySelectorAll('input[type="password"]')].filter(e => e.offsetWidth || e.offsetHeight).length`,
      );
      for (let i = 0; i < n; i++) {
        await page.fill(`input[type="password"] >> nth=${i}`, datos.cuentaPassword).catch(() => undefined);
      }
      if (crear) {
        await page.evaluate(`(function () {
          var cs = document.querySelectorAll('input[type="checkbox"]');
          for (var i = 0; i < cs.length; i++) if ((cs[i].offsetWidth || cs[i].offsetHeight) && !cs[i].checked) cs[i].click();
        })()`);
      }
      await this.capturar(page, job, crear ? 'workday-cuenta.png' : 'workday-cuenta-entrar.png');
      try {
        const loc = page.getByRole('button', {
          name: crear ? /create account/i : /^sign in$/i,
        }).first();
        if (await loc.isVisible()) {
          await loc.click();
          return;
        }
      } catch {
        // Se cae al clic por texto.
      }
      await this.clickTexto(page, [crear ? 'create account' : 'sign in']);
    };
    const enlaceSignInDelFormulario = async (): Promise<boolean> => {
      return page.evaluate<boolean>(`(function () {
        var as = document.querySelectorAll('a, button');
        var candidatos = [];
        for (var i = 0; i < as.length; i++) {
          var t = (as[i].textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
          if (t === 'sign in') candidatos.push(as[i]);
        }
        for (var j = 0; j < candidatos.length; j++) {
          var cont = candidatos[j].closest('div, form, section');
          if (cont && /already have an account/i.test(cont.textContent || '')) { candidatos[j].click(); return true; }
        }
        return false;
      })()`);
    };

    let altas = 0;
    let entradas = 0;
    for (let ronda = 0; ronda < 26; ronda++) {
      const estado = await clasificar().catch(() => 'desconocido' as Estado);
      if (estado === 'otro_paso') {
        await this.esperarContenido(page);
        return;
      }
      if (estado === 'selector') {
        await this.clickTexto(page, ['sign in with email']).catch(() => null);
        await page.waitForTimeout(2500);
        continue;
      }
      if (estado === 'formulario_crear') {
        if (altas === 0) {
          altas++;
          await this.capturar(page, job, 'workday-cuenta-form.png');
          await rellenarYEnviar(true);
          await page.waitForTimeout(6000);
          continue;
        }
        // El alta no avanzó (la cuenta ya existía): pasar a entrar
        // por el enlace del propio formulario.
        if (await enlaceSignInDelFormulario()) {
          await page.waitForTimeout(2500);
          continue;
        }
        await page.waitForTimeout(2000);
        continue;
      }
      if (estado === 'formulario_entrar') {
        // Verificación de correo: pantalla de código tras el alta.
        const t = await this.texto(page);
        if (/verify your email|verification code|check your email|confirm your email/i.test(t)) {
          await this.capturar(page, job, 'workday-verificacion.png');
          throw new AnomaliaEnvio(
            'captcha_mfa',
            'Workday pide verificar el correo electrónico para crear la cuenta: el código llega a tu email y hay que introducirlo en el asistente',
          );
        }
        if (entradas === 0) {
          entradas++;
          await rellenarYEnviar(false);
          await page.waitForTimeout(6000);
          continue;
        }
        await page.waitForTimeout(2000);
        continue;
      }
      // 'cargando' o 'desconocido': esperar a que pinte.
      await page.waitForTimeout(2500);
    }
    const errores = await page.evaluate<string[]>(ERRORES_JS).catch(() => []);
    await this.capturar(page, job, 'workday-cuenta-error.png');
    throw new AnomaliaEnvio(
      'formulario_cambiado',
      `Workday no aceptó la cuenta: ${errores.join(' · ').slice(0, 240) || (await this.texto(page)).slice(0, 240)}`,
    );
  }

  // --------------------------------------------------------------------
  // Paso 2: autofill con el CV.
  // --------------------------------------------------------------------
  private async pasoAutofill(page: PwPage, job: DriverJob): Promise<void> {
    const input = await page.$('input[type="file"]');
    if (input) {
      await page.setInputFiles('input[type="file"]', job.cvPath);
      await page.waitForTimeout(9000);
    }
    await this.capturar(page, job, 'workday-autofill.png');
  }

  // --------------------------------------------------------------------
  // Resolvedor de respuestas desde el perfil (solo lo determinable).
  // --------------------------------------------------------------------
  private resolverTexto(campo: CampoWD, job: DriverJob): string | null {
    const p = job.etiquetas;
    if (!p) return null;
    const l = norm(campo.etiqueta);
    const ciudad = p.ubicacion.split(',')[0]?.trim() ?? '';
    if (/first name|given name/.test(l)) return p.nombre;
    if (/last name|family name|surname/.test(l)) return p.apellidos;
    if (/full name|legal name|candidate name/.test(l)) return `${p.nombre} ${p.apellidos}`.trim();
    if (/^email|e mail|email address/.test(l)) return p.email;
    if (/phone|telefono|mobile|cell/.test(l)) return p.telefono.replace(/^\+34\s*/, '');
    if (/address line 1|street|direccion/.test(l)) return null; // sin hecho: se nombra al final
    if (/address line 2/.test(l)) return ''; // opcional: vacío válido
    if (/^city|ciudad/.test(l)) return ciudad;
    if (/postal|zip|postcode|codigo postal/.test(l)) return null;
    if (/linkedin/.test(l)) return p.linkedin;
    if (/salary|compensation|expected pay|pay expectation/.test(l)) return p.salarioEsperado;
    if (/how did you hear|source/.test(l)) return null;
    return null;
  }

  private resolverSiNo(campo: CampoWD): 'si' | 'no' | null {
    const l = norm(campo.grupo || campo.etiqueta);
    const autorizado = ZONA_DERECHO.has(this.paisPuesto) || this.paisPuesto === '';
    // Cuidado: paisPuesto '' (no detectado) NO equivale a autorizado;
    // solo se responde si el país se conoce.
    if (this.paisPuesto) {
      if (/authori[sz]ed to work|legally.*work|right to work|eligible to work/.test(l)) {
        return autorizado ? 'si' : 'no';
      }
      if (/sponsorship|require.*visa|visa.*support/.test(l)) {
        return autorizado ? 'no' : 'si';
      }
    }
    if (/at least 18|18 years of age|over 18/.test(l)) return 'si';
    if (/previously employed|worked (for|at) (us|the company)|former employee/.test(l)) return 'no';
    if (/relative|family member/.test(l) && /employ|work/.test(l)) return 'no';
    // Divulgaciones voluntarias: no declarar.
    if (/decline|prefer not|do not wish|not to answer/.test(l)) return 'si';
    return null;
  }

  private opcionSiNo(campo: CampoWD, r: 'si' | 'no'): string | null {
    const quiere = r === 'si' ? /^(yes|si|sí|true)$/i : /^(no|false)$/i;
    return campo.opciones.find((o) => quiere.test(o.trim())) ?? null;
  }

  private opcionDeclinar(campo: CampoWD): string | null {
    return (
      campo.opciones.find((o) =>
        /decline|do not wish|prefer not|not to answer|no deseo|no quiero/i.test(o),
      ) ?? null
    );
  }

  /** Rellena un desplegable (prompt) de Workday por texto exacto. */
  private async seleccionarPrompt(page: PwPage, campo: CampoWD, valor: string): Promise<boolean> {
    if (!campo.sel) return false;
    await page.click(campo.sel, { timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(1200);
    // Si se abrió un buscador, teclear el valor.
    const buscador = await page.$(
      'input[data-automation-id="searchBox"], [data-automation-id="promptSearch"] input, input[placeholder*="Search" i]',
    );
    if (buscador) {
      await page
        .fill(
          'input[data-automation-id="searchBox"], [data-automation-id="promptSearch"] input, input[placeholder*="Search" i]',
          valor,
        )
        .catch(() => undefined);
      await page.waitForTimeout(1200);
    }
    const elegido = await page.evaluate<boolean>(`(function (valor) {
      function norm(s) { return (s || '').replace(/\\s+/g, ' ').trim().toLowerCase(); }
      var ops = document.querySelectorAll('[data-automation-id="promptOption"], [role="option"], [role="listbox"] li, ul li div');
      for (var i = 0; i < ops.length; i++) {
        var t = norm(ops[i].textContent);
        if (t === norm(valor) || t.indexOf(norm(valor)) === 0) { ops[i].click(); return true; }
      }
      return false;
    })(${JSON.stringify(valor)})`);
    if (elegido) await page.waitForTimeout(800);
    return elegido;
  }

  /** Rellena todos los campos determinables del paso actual. */
  private async rellenarPaso(page: PwPage, job: DriverJob): Promise<{ rellenados: number; faltan: string[] }> {
    const campos = await page.evaluate<CampoWD[]>(DESCUBRIR_JS);
    let rellenados = 0;
    const faltan: string[] = [];
    const gruposRadioHechos = new Set<string>();
    for (const campo of campos) {
      try {
        if (campo.tipo === 'file') continue;
        if (campo.tipo === 'radio') {
          if (gruposRadioHechos.has(campo.grupo)) continue;
          gruposRadioHechos.add(campo.grupo);
          if (campo.valor) continue;
          const declinar = this.opcionDeclinar(campo);
          const sino = this.resolverSiNo(campo);
          const opcion =
            declinar ?? (sino ? this.opcionSiNo(campo, sino) : null);
          if (opcion) {
            const nombre = campo.sel.match(/name="([^"]+)"/)?.[1] ?? '';
            const marcada = await page.evaluate<string | null>(
              `${MARCAR_RADIO_JS}(${JSON.stringify({ name: nombre, opcion })})`,
            );
            if (marcada) rellenados++;
            else if (campo.requerido) faltan.push(campo.grupo || campo.etiqueta);
          } else if (campo.requerido) {
            faltan.push(campo.grupo || campo.etiqueta);
          }
          continue;
        }
        if (campo.tipo === 'checkbox') {
          if (campo.valor === 'on') continue;
          const l = norm(campo.etiqueta);
          // Solo certificaciones/consentimientos evidentes.
          if (/certify|confirm that|i agree|acknowledge|attest|declare that|consent/i.test(l)) {
            await page.evaluate(`(function (sel) {
              var e = document.querySelector(sel);
              if (e && !e.checked) e.click();
            })(${JSON.stringify(campo.sel)})`);
            rellenados++;
          } else if (campo.requerido) {
            faltan.push(campo.etiqueta);
          }
          continue;
        }
        if (campo.valor && campo.valor !== 'Select One' && campo.valor !== 'Search') continue;
        if (campo.tipo === 'select') {
          const l = norm(campo.etiqueta);
          let valor: string | null = null;
          if (/country/.test(l)) valor = job.etiquetas?.paisResidencia ?? null;
          else if (/gender|sex/.test(l)) valor = this.opcionDeclinar(campo);
          else {
            const t = this.resolverTexto(campo, job);
            valor = t && campo.opciones.some((o) => norm(o) === norm(t)) ? t : null;
          }
          if (valor) {
            await page.selectOption(campo.sel, { label: valor }).catch(() => undefined);
            rellenados++;
          } else if (campo.requerido) faltan.push(campo.etiqueta);
          continue;
        }
        if (campo.tipo === 'desplegable') {
          const l = norm(campo.etiqueta);
          let valor: string | null = null;
          if (/country/.test(l)) valor = job.etiquetas?.paisResidencia ?? 'Spain';
          else if (/phone.*(code|country)|country.*code/.test(l)) valor = 'Spain';
          else if (/device|phone type/.test(l)) valor = 'Mobile';
          else if (/gender|sex|ethnic|race|veteran|disability/.test(l)) valor = this.opcionDeclinar(campo);
          else if (/state|province|provincia|region/.test(l)) valor = 'La Rioja';
          if (valor) {
            const okSel = await this.seleccionarPrompt(page, campo, valor);
            if (okSel) rellenados++;
            else if (campo.requerido) faltan.push(campo.etiqueta);
          } else if (campo.requerido) {
            faltan.push(campo.etiqueta);
          }
          continue;
        }
        // Texto / email / tel / textarea / fecha / número.
        const respuesta = this.resolverTexto(campo, job);
        if (respuesta !== null && campo.sel) {
          if (respuesta !== '') {
            await page.fill(campo.sel, respuesta, { timeout: 5000 });
            rellenados++;
          }
        } else if (campo.requerido) {
          faltan.push(campo.etiqueta);
        }
      } catch {
        if (campo.requerido) faltan.push(campo.etiqueta);
      }
    }
    return { rellenados, faltan };
  }

  private async clickSiguiente(page: PwPage): Promise<boolean> {
    const t = await this.clickTexto(page, [
      'save and continue',
      'save & continue',
      'next',
      'continue',
      'save',
    ]);
    return t !== null;
  }

  private async prepararInterno(job: DriverJob): Promise<PreparacionResultado> {
    const page = await this.pageActiva(job);
    await this.abrirAsistente(page, job);
    let paso = await page.evaluate<string>(PASO_JS).catch(() => '');
    if (/create account|sign in/i.test(paso)) {
      await this.pasoCuenta(page, job);
      paso = await page.evaluate<string>(PASO_JS).catch(() => '');
    }
    let rellenadosTotal = 0;
    for (let i = 0; i < 10; i++) {
      await this.esperarContenido(page, 6);
      if (await this.captchaVisible(page)) {
        await this.capturar(page, job, 'workday-captcha.png');
        throw new AnomaliaEnvio('captcha_mfa', 'Workday muestra un captcha visible en el asistente');
      }
      paso = await page.evaluate<string>(PASO_JS).catch(() => '');
      if (/review/i.test(paso)) break;
      if (/autofill/i.test(paso)) {
        await this.pasoAutofill(page, job);
      } else {
        const { rellenados, faltan } = await this.rellenarPaso(page, job);
        rellenadosTotal += rellenados;
        await this.capturar(page, job, `workday-paso-${i + 1}.png`);
        if (faltan.length > 0) {
          // Un intento de avanzar igualmente: Workday a veces marca
          // como requerido lo opcional; si bloquea, el error lo nombra.
          const antes = paso;
          const clickOk = await this.clickSiguiente(page);
          await page.waitForTimeout(3000);
          const errores = await page.evaluate<string[]>(ERRORES_JS).catch(() => []);
          const nuevoPaso = await page.evaluate<string>(PASO_JS).catch(() => '');
          if (!clickOk || nuevoPaso === antes) {
            throw new AnomaliaEnvio(
              'datos_ausentes',
              `Workday exige y no consta en el perfil: ${[...new Set(faltan)].join(' · ').slice(0, 300)}${errores.length ? ` — ${errores.join(' · ').slice(0, 200)}` : ''}`,
            );
          }
          continue;
        }
      }
      const antes = paso;
      const okClick = await this.clickSiguiente(page);
      if (!okClick) {
        if (/review/i.test(await this.texto(page))) break;
        throw new AnomaliaEnvio(
          'formulario_cambiado',
          `sin botón de avance en el paso «${paso || 'desconocido'}» de Workday`,
        );
      }
      await page.waitForTimeout(3500);
      const errores = await page.evaluate<string[]>(ERRORES_JS).catch(() => []);
      const nuevoPaso = await page.evaluate<string>(PASO_JS).catch(() => '');
      if (nuevoPaso === antes && errores.length > 0) {
        throw new AnomaliaEnvio(
          'datos_ausentes',
          `Workday no deja avanzar en «${antes}»: ${errores.join(' · ').slice(0, 320)}`,
        );
      }
    }
    paso = await page.evaluate<string>(PASO_JS).catch(() => '');
    await this.capturar(page, job, 'workday-review.png');
    if (!/review/i.test(paso) && !/review/i.test(await this.texto(page))) {
      throw new AnomaliaEnvio(
        'formulario_cambiado',
        `el asistente de Workday no llegó al paso Review (último paso visto: «${paso || '—'}»)`,
      );
    }
    return { camposRellenados: rellenadosTotal, uploadsOk: true, capturas: this.capturas };
  }

  async preparar(job: DriverJob): Promise<PreparacionResultado> {
    return this.prepararInterno(job);
  }

  async enviarYConfirmar(job: DriverJob): Promise<ResultadoDriver> {
    const page = await this.pageActiva(job);
    const submit = await this.clickTexto(page, ['submit', 'submit application']);
    if (!submit) {
      throw new AnomaliaEnvio('formulario_cambiado', 'sin botón Submit en el Review de Workday');
    }
    await page.waitForTimeout(4000);
    // Posible modal de confirmación.
    await this.clickTexto(page, ['submit', 'confirm', 'ok', 'yes']).catch(() => null);
    const EXITO = /application submitted|submitted successfully|successfully submitted|thank you for applying|application has been received|you have (successfully )?applied/i;
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(3000);
      const texto = await this.texto(page);
      if (EXITO.test(texto)) {
        await this.capturar(page, job, 'workday-tras-envio.png');
        const m = texto.match(/.{0,60}(application submitted|successfully submitted|thank you for applying).{0,80}/i);
        const req = job.applyUrl.match(/_(R\d{3,})/)?.[1] ?? null;
        return {
          confirmado: true,
          confirmacion: {
            mensaje: (m?.[0] ?? 'Candidatura enviada en Workday').replace(/\s+/g, ' ').trim().slice(0, 220),
            urlTrasEnvio: page.url(),
            referencia: req,
            capturas: this.capturas,
          },
          capturas: this.capturas,
          evidencia: { via: 'workday', pasoFinal: 'review-submit' },
        };
      }
      if (/candidate home|my applications/i.test(texto) && /in progress|submitted/i.test(texto)) {
        await this.capturar(page, job, 'workday-tras-envio.png');
        const req = job.applyUrl.match(/_(R\d{3,})/)?.[1] ?? null;
        return {
          confirmado: true,
          confirmacion: {
            mensaje: 'Workday muestra la candidatura en «My Applications»',
            urlTrasEnvio: page.url(),
            referencia: req,
            capturas: this.capturas,
          },
          capturas: this.capturas,
          evidencia: { via: 'workday', pasoFinal: 'candidate-home' },
        };
      }
    }
    await this.capturar(page, job, 'workday-tras-envio.png');
    return {
      confirmado: false,
      capturas: this.capturas,
      evidencia: { via: 'workday', nota: 'sin señal de éxito visible tras Submit' },
    };
  }
}
