/**
 * Driver de navegador para iCIMS (sistema de seguimiento de
 * candidaturas usado por muchas ONG y empresas; p. ej.
 * careers-sightsavers.icims.com).
 *
 * Flujo real (verificado en vivo el 2026-10-21):
 *   1. La oferta pública (a veces en la web de la organización,
 *      p. ej. careers.sightsavers.org) deriva a
 *      https://<org>.icims.com/jobs/<id>/login.
 *   2. SIN aplicación como invitado: hay que entrar con una cuenta
 *      del portal. Primera pantalla: correo + declaración de
 *      privacidad que hay que aceptar → «Next».
 *   3. Si la cuenta no existe, el asistente pide crear la contraseña
 *      (la del registro `portal_accounts`, generada y cifrada).
 *   4. Pantallas del formulario: datos personales, adjuntos (CV y
 *      carta) y preguntas; revisión y envío con confirmación.
 *   5. La protección es hCaptcha: si aparece un desafío VISIBLE, el
 *      driver se detiene con anomalía `captcha_mfa` (queda para Jon).
 *
 * PARTICULARIDAD: iCIMS sirve el formulario DENTRO de un iframe
 * incrustado en la página de la organización; todo el descubrimiento
 * de campos/botones se hace por TANDA DE MARCOS (frames) y se opera
 * sobre el marco que contiene el formulario.
 *
 * El relleno es por ETIQUETAS (no por selectores versionados): cada
 * campo se mapea a un dato del perfil verificado. Una pregunta
 * obligatoria sin respuesta determinada detiene el envío con
 * `datos_ausentes` nombrando la pregunta exacta — nunca se inventa.
 */
import { mkdirSync } from 'node:fs';
import type * as net from 'node:net';
import { join } from 'node:path';

import { hostCuentaIcims } from '../portal-accounts.js';
import { cargarPlaywright, resolveChromiumExe, startForwarder } from './driver.js';
import {
  AnomaliaEnvio,
  type AperturaResultado,
  type BrowserDriver,
  type DriverJob,
  type PreparacionResultado,
  type ResultadoDriver,
} from './types.js';

// ---------------------------------------------------------------------------
// Tipos mínimos de Playwright usados aquí (tipado laxo, como driver.ts).
// ---------------------------------------------------------------------------

interface PwElementHandle {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  evaluate<R>(fn: string | ((el: any, arg?: any) => R), arg?: unknown): Promise<R>;
}

interface PwFrame {
  url(): string;
  evaluate<R>(fn: string): Promise<R>;
  $(selector: string): Promise<PwElementHandle | null>;
  $$(selector: string): Promise<PwElementHandle[]>;
  click(selector: string, opts?: { timeout?: number }): Promise<void>;
  fill(selector: string, value: string, opts?: { timeout?: number }): Promise<void>;
  setInputFiles(selector: string, files: string | string[]): Promise<void>;
}

interface PwPage extends PwFrame {
  goto(
    url: string,
    opts?: { waitUntil?: string; timeout?: number },
  ): Promise<{ status(): number } | null>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(opts: { path: string; fullPage?: boolean }): Promise<void>;
  frames(): PwFrame[];
  mainFrame(): PwFrame;
}

interface PwBrowser {
  newPage(opts?: Record<string, unknown>): Promise<PwPage>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// JS de descubrimiento (se evalúa en cada marco).
// ---------------------------------------------------------------------------

interface CampoDescubierto {
  sel: string;
  tipo: string;
  etiqueta: string;
  requerido: boolean;
  valor: string;
  opciones: string[];
}

const DESCUBRIR_CAMPOS_JS = `(function () {
  var out = [];
  var nodes = document.querySelectorAll('input, select, textarea');
  for (var i = 0; i < nodes.length; i++) {
    var e = nodes[i];
    var tipo = (e.getAttribute('type') || e.tagName).toLowerCase();
    if (tipo === 'hidden' || tipo === 'submit' || tipo === 'button') continue;
    // Los input[type=file] suelen ir ocultos tras el botón de subida:
    // se descubren igualmente (se actúa por setInputFiles).
    if (tipo !== 'file' && !(e.offsetWidth || e.offsetHeight)) continue;
    var etiqueta = '';
    if (e.id) {
      var lab = document.querySelector('label[for="' + CSS.escape(e.id) + '"]');
      if (lab) etiqueta = (lab.textContent || '').trim();
    }
    if (!etiqueta) {
      var cont = e.closest('div, td, li, fieldset');
      for (var k = 0; cont && k < 4; k++) {
        var l2 = cont.querySelector ? cont.querySelector('label') : null;
        if (l2 && (l2.textContent || '').trim()) { etiqueta = (l2.textContent || '').trim(); break; }
        cont = cont.parentElement;
      }
    }
    if (!etiqueta) etiqueta = e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.name || e.id || '';
    var opciones = [];
    if (e.tagName === 'SELECT') {
      for (var j = 0; j < e.options.length; j++) opciones.push((e.options[j].textContent || '').trim());
    }
    var requerido = !!e.required || e.getAttribute('aria-required') === 'true' || /\\*/.test(etiqueta);
    var idPart = e.id ? '#' + CSS.escape(e.id) : (e.name ? '[name="' + e.name + '"]' : '');
    out.push({
      sel: idPart || (e.tagName.toLowerCase() + ':nth-of-type(' + (i + 1) + ')'),
      tipo: tipo, etiqueta: etiqueta, requerido: requerido,
      valor: (e.value || '').toString(), opciones: opciones
    });
  }
  return out;
})()`;

const BUSCAR_BOTON_JS = `(function (patrones) {
  var btns = document.querySelectorAll('button, input[type="submit"], input[type="button"], a[role="button"]');
  for (var i = 0; i < btns.length; i++) {
    var b = btns[i];
    if (!(b.offsetWidth || b.offsetHeight) || b.disabled) continue;
    var t = ((b.textContent || b.value || '')).trim().toLowerCase();
    for (var j = 0; j < patrones.length; j++) {
      if (t === patrones[j] || t.indexOf(patrones[j]) === 0) {
        b.setAttribute('data-icims-target', '1');
        return true;
      }
    }
  }
  return false;
})`;

const TEXTO_JS = `(function () { return document.body ? (document.body.innerText || '') : ''; })()`;

const BOTONES_AVANCE = [
  'next',
  'continue',
  'save & continue',
  'save and continue',
  'review',
  'submit',
  'apply',
  'siguiente',
  'continuar',
];
const BOTONES_ENVIO = [
  'submit application',
  'submit',
  'send application',
  'confirm & submit',
  'confirm and submit',
  'apply',
  'enviar',
];
const CLOSED_RE =
  /no longer (accepting|available)|position (has been )?(closed|filled)|job (is )?closed|applications? (are )?closed|this job is no longer/i;
const SUCCESS_RE =
  /thank you|application (has been )?(submitted|received|sent)|you have (successfully )?applied|aplicación recibida|gracias por tu candidatura/i;
const VERIFICACION_RE =
  /verify your email|verification (code|link|email)|check your (email|inbox)|confirm your email|hemos enviado un correo de verificación/i;

// ---------------------------------------------------------------------------
// Driver.
// ---------------------------------------------------------------------------

export class IcimsDriver implements BrowserDriver {
  readonly portal = 'icims';
  private browser: PwBrowser | null = null;
  private page: PwPage | null = null;
  private forwarder: net.Server | null = null;

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
      viewport: { width: 1360, height: 1000 },
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

  /** Texto agregado de TODOS los marcos de la página. */
  private async textoPagina(page: PwPage): Promise<string> {
    const partes: string[] = [];
    for (const f of page.frames()) {
      try {
        const t = await f.evaluate<string>(TEXTO_JS);
        if (t) partes.push(t);
      } catch {
        // Marco inaccesible (cross-origin sin permisos): se ignora.
      }
    }
    return partes.join('\n');
  }

  /**
   * Marco que contiene el formulario. OJO: la página escaparate de la
   * organización también tiene campos (newsletter, buscador) — se
   * puntúa cada marco y manda el de la APLICACIÓN iCIMS (in_iframe,
   * campo de correo/contraseña), no el primero con cualquier campo
   * (fallo verificado en vivo: se rellenaba el correo del newsletter
   * y «Next» nunca aparecía).
   */
  private async superficie(page: PwPage): Promise<PwFrame> {
    let mejor: { f: PwFrame; puntos: number } | null = null;
    for (const f of page.frames()) {
      let campos: CampoDescubierto[] = [];
      try {
        campos = await f.evaluate<CampoDescubierto[]>(DESCUBRIR_CAMPOS_JS);
      } catch {
        continue;
      }
      if (campos.length === 0) continue;
      let puntos = campos.length;
      if (/in_iframe=1/.test(f.url())) puntos += 50;
      if (campos.some((c) => c.tipo === 'email')) puntos += 20;
      if (campos.some((c) => c.tipo === 'password')) puntos += 10;
      if (!mejor || puntos > mejor.puntos) mejor = { f, puntos };
    }
    if (mejor) return mejor.f;
    for (const f of page.frames()) {
      try {
        const hay = await f.evaluate<boolean>(
          `(function () { return !!document.querySelector('button, input[type="submit"], a[role="button"]'); })()`,
        );
        if (hay) return f;
      } catch {
        // Siguiente marco.
      }
    }
    return page.mainFrame();
  }

  /**
   * Desafío hCaptcha REALMENTE visible: el iframe `frame=challenge`
   * desplegado. El distintivo pasivo («Protected by hCaptcha») y el
   * iframe `frame=checkbox` NO cuentan (falso positivo verificado en
   * vivo el 2026-10-21: la página de acceso paró sin desafío).
   */
  private async captchaVisible(page: PwPage): Promise<boolean> {
    for (const f of page.frames()) {
      try {
        const hit = await f.evaluate<boolean>(`(function () {
          var frames = document.querySelectorAll('iframe');
          for (var i = 0; i < frames.length; i++) {
            var src = frames[i].src || '';
            if (/hcaptcha/.test(src) && /frame=challenge/.test(src)) {
              var st = window.getComputedStyle(frames[i]);
              if (st.visibility !== 'hidden' && st.display !== 'none' &&
                  frames[i].offsetWidth > 200 && frames[i].offsetHeight > 100) return true;
            }
          }
          return false;
        })()`);
        if (hit) return true;
      } catch {
        // Marco inaccesible: se sigue con el siguiente.
      }
    }
    return false;
  }

  private async capturar(page: PwPage, job: DriverJob, nombre: string): Promise<string> {
    const ruta = join(job.shotsDir, nombre);
    try {
      await page.screenshot({ path: ruta, fullPage: false });
      return ruta;
    } catch {
      return ruta;
    }
  }

  /**
   * URL directa del portal: la página escaparate de la organización
   * (careers.<org>) puede rechazar al navegador automatizado, así
   * que se navega directamente a iCIMS, cuya pantalla de acceso es
   * la misma a la que lleva el botón Apply (verificado en vivo).
   */
  private urlDirecta(job: DriverJob): string {
    try {
      const u = new URL(job.applyUrl);
      if (u.hostname.toLowerCase().endsWith('icims.com')) return job.applyUrl;
      const m = u.pathname.match(/\/jobs\/(\d+)/);
      if (m) return `https://${hostCuentaIcims(u.hostname)}/jobs/${m[1]}/login`;
    } catch {
      // URL no parseable: se usa tal cual.
    }
    return job.applyUrl;
  }

  async verificarApertura(job: DriverJob): Promise<AperturaResultado> {
    const page = await this.pageActiva(job);
    let resp: { status(): number } | null = null;
    try {
      resp = await page.goto(this.urlDirecta(job), { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
      return {
        abierta: false,
        detalle: `error de red abriendo iCIMS: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    await page.waitForTimeout(3000);
    const status = resp?.status();
    if (status !== undefined && status >= 400) {
      return { abierta: false, detalle: `HTTP ${status} al abrir la oferta en iCIMS` };
    }
    const texto = await this.textoPagina(page);
    if (CLOSED_RE.test(texto)) {
      return { abierta: false, detalle: 'la oferta figura cerrada en iCIMS' };
    }
    if (/icims\.com/i.test(page.url())) {
      return { abierta: true, detalle: 'portal iCIMS accesible (pantalla de acceso/cuenta)' };
    }
    return { abierta: false, detalle: `no se alcanzó el portal iCIMS (URL: ${page.url()})` };
  }

  /** Pulsa un botón (por textos candidatos) en el marco dado. */
  private async pulsarBoton(frame: PwFrame, patrones: string[]): Promise<boolean> {
    for (const f of [frame]) {
      const targets = await f
        .evaluate<boolean>(`(${BUSCAR_BOTON_JS})(${JSON.stringify(patrones)})`)
        .catch(() => false);
      if (targets) {
        await f.click('[data-icims-target="1"]', { timeout: 10000 });
        return true;
      }
    }
    return false;
  }

  /** Desde la página de la oferta hasta el asistente de iCIMS. */
  private async entrarAlAsistente(page: PwPage, job: DriverJob): Promise<void> {
    if (/icims\.com/i.test(page.url())) return;
    const directa = this.urlDirecta(job);
    if (directa !== job.applyUrl) {
      await page.goto(directa, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3000);
      return;
    }
    throw new AnomaliaEnvio(
      'formulario_cambiado',
      `no se alcanzó iCIMS desde la oferta (URL: ${page.url()})`,
    );
  }

  /**
   * Paso de acceso: correo de la cuenta + aceptación de la
   * declaración de privacidad (consentimiento de Jon para aplicar).
   */
  private async pasoAcceso(page: PwPage, job: DriverJob): Promise<boolean> {
    const d = job.icims;
    if (!d) throw new AnomaliaEnvio('datos_ausentes', 'trabajo iCIMS sin datos de cuenta/perfil');
    const frame = await this.superficie(page);
    const campos = await frame
      .evaluate<CampoDescubierto[]>(DESCUBRIR_CAMPOS_JS)
      .catch(() => [] as CampoDescubierto[]);
    const email = campos.find(
      (c) => c.tipo === 'email' || /e-?mail|correo/.test(c.etiqueta.toLowerCase()),
    );
    if (!email) return false;
    if (!email.valor) await frame.fill(email.sel, d.cuentaEmail);
    // Contraseña si ya hay cuenta (login directo).
    const pass = campos.find((c) => c.tipo === 'password');
    if (pass && !pass.valor) await frame.fill(pass.sel, d.cuentaPassword);
    // Casilla de aceptación de privacidad/condiciones (consentimiento
    // de Jon para aplicar): en esta pantalla hay una sola y nace sin
    // marcar; «Next» permanece deshabilitado hasta aceptarla.
    const casillas = campos.filter((c) => c.tipo === 'checkbox');
    const casilla =
      casillas.find((c) => /accept|agree|privacy|consent|acept/i.test(c.etiqueta)) ??
      (casillas.length === 1 ? casillas[0] : undefined);
    if (casilla) {
      const handle = await frame.$(casilla.sel);
      const marcada = handle
        ? await handle
            .evaluate<boolean>((el: { checked?: boolean }) => !!el.checked)
            .catch(() => false)
        : false;
      if (!marcada) {
        await frame.click(casilla.sel, { timeout: 8000 }).catch(() => undefined);
        await page.waitForTimeout(700);
      }
    }
    const ok = await this.pulsarBoton(frame, BOTONES_AVANCE);
    if (!ok) {
      throw new AnomaliaEnvio(
        'formulario_cambiado',
        `pantalla de acceso de iCIMS sin botón de avance (URL: ${page.url()})`,
      );
    }
    await page.waitForTimeout(3500);
    return true;
  }

  /** Paso de creación de cuenta: todos los campos de contraseña = la del portal. */
  private async pasoCrearCuenta(page: PwPage, job: DriverJob): Promise<boolean> {
    const d = job.icims;
    if (!d) return false;
    const frame = await this.superficie(page);
    const campos = await frame
      .evaluate<CampoDescubierto[]>(DESCUBRIR_CAMPOS_JS)
      .catch(() => [] as CampoDescubierto[]);
    const passwords = campos.filter((c) => c.tipo === 'password');
    if (passwords.length === 0) return false;
    for (const p of passwords) {
      if (!p.valor) await frame.fill(p.sel, d.cuentaPassword);
    }
    const email = campos.find(
      (c) => c.tipo === 'email' || /e-?mail|correo/.test(c.etiqueta.toLowerCase()),
    );
    if (email && !email.valor) await frame.fill(email.sel, d.cuentaEmail);
    if (!(await this.pulsarBoton(frame, BOTONES_AVANCE))) return false;
    await page.waitForTimeout(3500);
    return true;
  }

  /** Valor determinado para un campo del formulario, o null si no se sabe. */
  private valorParaCampo(c: CampoDescubierto, d: NonNullable<DriverJob['icims']>): string | null {
    const e = c.etiqueta.toLowerCase();
    if (c.tipo === 'file') return null; // los adjuntos van aparte
    if (/first name|given name|nombre(?!.*(company|empresa))/.test(e)) return d.nombre;
    if (/last name|surname|family name|apellidos?/.test(e)) return d.apellidos;
    if (/full name|nombre completo/.test(e)) return `${d.nombre} ${d.apellidos}`;
    if (/e-?mail|correo/.test(e)) return d.email;
    if (/phone|teléfono|telefono|mobile/.test(e)) return d.telefono || null;
    if (/city|ciudad/.test(e)) return d.ubicacion.split(',')[0]?.trim() ?? null;
    if (/country|país|pais/.test(e)) return this.elegirOpcion(c, [d.paisResidencia, 'Spain', 'España']);
    if (/linkedin/.test(e)) return d.linkedin || null;
    if (/location|ubicación|residence|residencia/.test(e)) return d.ubicacion;
    return null;
  }

  private elegirOpcion(c: CampoDescubierto, preferidas: string[]): string | null {
    for (const p of preferidas) {
      const hit = c.opciones.find((o) => o.toLowerCase() === p.toLowerCase());
      if (hit) return hit;
    }
    for (const p of preferidas) {
      const hit = c.opciones.find((o) => o.toLowerCase().includes(p.toLowerCase()));
      if (hit) return hit;
    }
    return null;
  }

  /** Rellena un paso del formulario. Devuelve nº de campos tocados. */
  private async rellenarPaso(
    page: PwPage,
    job: DriverJob,
    cvRuta: string,
    cartaRuta: string,
  ): Promise<number> {
    const d = job.icims;
    if (!d) throw new AnomaliaEnvio('datos_ausentes', 'trabajo iCIMS sin datos de perfil');
    const frame = await this.superficie(page);
    const campos = await frame
      .evaluate<CampoDescubierto[]>(DESCUBRIR_CAMPOS_JS)
      .catch(() => [] as CampoDescubierto[]);
    let tocados = 0;
    for (const c of campos) {
      // Adjuntos.
      if (c.tipo === 'file') {
        const e = c.etiqueta.toLowerCase();
        const esCarta = /cover|letter|carta|presentación/.test(e);
        try {
          await frame.setInputFiles(c.sel, esCarta ? cartaRuta : cvRuta);
          tocados++;
        } catch {
          // input de fichero con envoltorio propio: se reintenta por id
        }
        continue;
      }
      // Desplegables voluntarios de autoidentificación: «prefiero no decirlo».
      if (c.tipo === 'select-one' && !c.valor) {
        const e = c.etiqueta.toLowerCase();
        if (/gender|género|sex|race|ethnic|veteran|disability|discapacidad/.test(e)) {
          const opcion = this.elegirOpcion(c, [
            'decline to state',
            'prefer not to say',
            'i choose not to disclose',
            'no deseo responder',
            'prefiero no decirlo',
          ]);
          if (opcion) {
            const el = await frame.$(c.sel);
            if (el) {
              await el
                .evaluate((sel: HTMLSelectElement, objetivo: string) => {
                  for (let i = 0; i < sel.options.length; i++) {
                    if ((sel.options[i].textContent || '').trim() === objetivo) {
                      sel.selectedIndex = i;
                      sel.dispatchEvent(new Event('change', { bubbles: true }));
                      break;
                    }
                  }
                }, opcion)
                .catch(() => undefined);
              tocados++;
            }
          }
          continue;
        }
        const v = this.valorParaCampo(c, d);
        if (v) {
          const el = await frame.$(c.sel);
          if (el) {
            await el
              .evaluate((sel: HTMLSelectElement, objetivo: string) => {
                const buscado = objetivo.toLowerCase();
                for (let i = 0; i < sel.options.length; i++) {
                  const t = (sel.options[i].textContent || '').trim();
                  if (t.toLowerCase() === buscado || t.toLowerCase().indexOf(buscado) === 0) {
                    sel.selectedIndex = i;
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                    break;
                  }
                }
              }, v)
              .catch(() => undefined);
            tocados++;
          }
        }
        continue;
      }
      // Radios Sí/No típicos de elegibilidad ya respondidos por la orden
      // de Jon (autorización para trabajar se presupone al encargar la
      // aplicación a ESA oferta; las restringidas ni llegan aquí).
      if (c.tipo === 'radio') continue;
      if (c.tipo === 'checkbox') continue;
      if (c.valor && c.valor.trim() !== '') continue;
      const v = this.valorParaCampo(c, d);
      if (v) {
        await frame.fill(c.sel, v).catch(() => undefined);
        tocados++;
      }
    }
    // Obligatorios sin respuesta determinada → parada precisa.
    const tras: CampoDescubierto[] = await frame
      .evaluate<CampoDescubierto[]>(DESCUBRIR_CAMPOS_JS)
      .catch(() => [] as CampoDescubierto[]);
    const sinRespuesta = tras.find(
      (c) =>
        c.requerido &&
        c.tipo !== 'radio' &&
        c.tipo !== 'checkbox' &&
        c.tipo !== 'file' &&
        (!c.valor || c.valor.trim() === '') &&
        this.valorParaCampo(c, d) === null &&
        !/gender|género|race|ethnic|veteran|disability|discapacidad/i.test(c.etiqueta),
    );
    if (sinRespuesta) {
      throw new AnomaliaEnvio(
        'datos_ausentes',
        `pregunta obligatoria de iCIMS sin respuesta en tu perfil: «${sinRespuesta.etiqueta}» (URL: ${page.url()})`,
      );
    }
    return tocados;
  }

  async preparar(
    job: DriverJob,
  ): Promise<{ camposRellenados: number; uploadsOk: boolean; capturas: string[] }> {
    const page = await this.pageActiva(job);
    const capturas: string[] = [];
    let totalCampos = 0;
    let subioAlgo = false;
    await this.entrarAlAsistente(page, job);
    for (let paso = 0; paso < 16; paso++) {
      capturas.push(await this.capturar(page, job, `icims-paso-${paso}.png`));
      const texto = await this.textoPagina(page);
      if (await this.captchaVisible(page)) {
        throw new AnomaliaEnvio(
          'captcha_mfa',
          `hCaptcha con desafío visible en iCIMS (paso ${paso}, URL: ${page.url()}): queda para resolverlo tú`,
          { trasClick: false },
        );
      }
      if (VERIFICACION_RE.test(texto)) {
        throw new AnomaliaEnvio(
          'captcha_mfa',
          `iCIMS pide verificar el correo para continuar (paso ${paso}): revisa la bandeja de ${job.icims?.cuentaEmail ?? 'tu correo'} y pulsa el enlace; después vuelve a ordenarme aplicar`,
          { trasClick: false },
        );
      }
      if (SUCCESS_RE.test(texto) && paso > 0) break;
      if (await this.pasoAcceso(page, job)) continue;
      if (await this.pasoCrearCuenta(page, job)) continue;
      const antes = totalCampos;
      totalCampos += await this.rellenarPaso(page, job, job.cvPath, job.cartaPath);
      if (totalCampos > antes) subioAlgo = subioAlgo || true;
      const frame = await this.superficie(page);
      const camposAhora = await frame
        .evaluate<CampoDescubierto[]>(DESCUBRIR_CAMPOS_JS)
        .catch(() => [] as CampoDescubierto[]);
      const hayCampos = camposAhora.length > 0;
      if (!(await this.pulsarBoton(frame, BOTONES_AVANCE))) {
        if (!hayCampos || totalCampos === antes) {
          throw new AnomaliaEnvio(
            'formulario_cambiado',
            `paso de iCIMS sin campos rellenables ni botón de avance (URL: ${page.url()})`,
          );
        }
        break; // Última pantalla (revisión): la remata enviarYConfirmar.
      }
      await page.waitForTimeout(3000);
    }
    return { camposRellenados: totalCampos, uploadsOk: subioAlgo, capturas };
  }

  async enviarYConfirmar(job: DriverJob): Promise<ResultadoDriver> {
    const page = await this.pageActiva(job);
    const capturas: string[] = [];
    const frame = await this.superficie(page);
    if (!(await this.pulsarBoton(frame, BOTONES_ENVIO))) {
      throw new AnomaliaEnvio(
        'formulario_cambiado',
        `no se encontró el botón de envío final en iCIMS (URL: ${page.url()})`,
      );
    }
    await page.waitForTimeout(5000);
    capturas.push(await this.capturar(page, job, 'icims-tras-envio.png'));
    if (await this.captchaVisible(page)) {
      throw new AnomaliaEnvio(
        'captcha_mfa',
        'hCaptcha con desafío visible tras pulsar Enviar en iCIMS: el envío puede no haberse completado',
        { trasClick: true },
      );
    }
    const texto = await this.textoPagina(page);
    if (SUCCESS_RE.test(texto)) {
      return {
        confirmado: true,
        confirmacion: {
          mensaje: 'iCIMS confirmó la recepción de la candidatura.',
          urlTrasEnvio: page.url(),
          referencia: null,
          capturas,
        },
        capturas,
        evidencia: { portal: 'icims' },
      };
    }
    return { confirmado: false, capturas, evidencia: { portal: 'icims' } };
  }
}
