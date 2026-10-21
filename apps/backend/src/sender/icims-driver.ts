/**
 * @jobforce/backend — Driver de navegador para iCIMS (ejecutor de envíos).
 *
 * iCIMS no es un formulario único: es un asistente con cuenta
 * (login con email + aceptación de privacidad → creación de cuenta →
 * perfil/candidatura por pasos → revisión → envío). Verificado en
 * vivo contra Sightsavers (2026-10-21): el botón Apply salta a
 * `*.icims.com/jobs/<id>/login`, sin aplicación como invitado y con
 * hCaptcha protegiendo el flujo.
 *
 * Reglas del driver (las mismas que en Personio, adaptadas):
 * - Solo rellena datos del perfil aprobado de Jon y la cuenta del
 *   portal (gestionada cifrada por `portal-accounts.ts`).
 * - NUNCA inventa respuestas: una pregunta obligatoria sin respuesta
 *   determinada (elegibilidad, salario, código postal…) detiene el
 *   envío con una anomalía precisa y captura — intervención para Jon.
 * - En secciones voluntarias (EEO) elige «prefiero no decirlo» si
 *   existe: es la no-respuesta veraz.
 * - Un CAPTCHA/hCaptcha con desafío visible o una verificación por
 *   correo detienen el flujo (anomalía captcha_mfa), nunca se fuerzan.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type net from 'node:net';
import { cargarPlaywright, resolveChromiumExe, startForwarder } from './driver.js';
import {
  AnomaliaEnvio,
  type AperturaResultado,
  type BrowserDriver,
  type ConfirmacionEnvio,
  type DriverJob,
  type PreparacionResultado,
  type ResultadoDriver,
} from './types.js';

// ---------------------------------------------------------------------------
// Superficie mínima de playwright-core (tipos locales, como en driver.ts).
// ---------------------------------------------------------------------------

interface PwLocator {
  first(): PwLocator;
  nth(i: number): PwLocator;
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  click(): Promise<void>;
  fill(v: string): Promise<void>;
  check(): Promise<void>;
  selectOption(v: { label: string } | { index: number }): Promise<string[]>;
  setInputFiles(f: string): Promise<void>;
  getAttribute(name: string): Promise<string | null>;
  scrollIntoViewIfNeeded(): Promise<void>;
}

interface PwPage {
  goto(url: string, opts?: Record<string, unknown>): Promise<{ status(): number } | null>;
  evaluate<T>(fn: string | ((...args: never[]) => T), arg?: unknown): Promise<T>;
  fill(selector: string, value: string): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  waitForFunction(fn: unknown, arg?: unknown, opts?: { timeout?: number; polling?: number }): Promise<void>;
  waitForURL(re: RegExp, opts?: { timeout?: number }): Promise<void>;
  screenshot(opts?: Record<string, unknown>): Promise<Buffer>;
  getByRole(role: string, opts?: { name: RegExp }): PwLocator;
  locator(selector: string): PwLocator;
  url(): string;
}

interface PwBrowser {
  newPage(opts?: Record<string, unknown>): Promise<PwPage>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Señales y descubrimiento de campos (se evalúan en la página).
// ---------------------------------------------------------------------------

const CLOSED_RE = /no longer (available|accepting)|position (has been )?filled|job (has been )?closed|applications? (are )?closed/i;
const SUCCESS_RE = /thank you|application (has been |was )?submitted|received your application|successfully (applied|submitted)|application complete/i;

const HCAPTCHA_CHALLENGE_JS = `[...document.querySelectorAll("iframe")]
  .filter(f => /hcaptcha|recaptcha|turnstile/i.test(f.src || "") && f.offsetParent !== null && (f.clientWidth > 200 || /challenge/i.test(f.title || "")))
  .map(f => (f.src || "").slice(0, 120))`;

interface CampoDescubierto {
  sel: string;
  tipo: string; // input type, 'select' o 'textarea'
  etiqueta: string;
  requerido: boolean;
  valor: string;
  opciones?: string[];
}

/** Descubre los campos visibles y rellenables del paso actual. */
const DESCUBRIR_CAMPOS_JS = `(() => {
  const visible = (el) => !!(el.offsetParent || el.getClientRects().length) && el.type !== 'hidden';
  const etiquetaDe = (el) => {
    let t = '';
    if (el.id) {
      const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lab) t = lab.innerText || '';
    }
    if (!t) { const wrap = el.closest('label'); if (wrap) t = wrap.innerText || ''; }
    if (!t) t = el.getAttribute('aria-label') || el.placeholder || el.name || '';
    return t.replace(/\\s+/g, ' ').trim().slice(0, 120);
  };
  const selDe = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    if (el.name) return el.tagName.toLowerCase() + '[name="' + el.name + '"]';
    return null;
  };
  const out = [];
  for (const el of document.querySelectorAll('input, select, textarea')) {
    if (!visible(el)) continue;
    const tag = el.tagName.toLowerCase();
    const tipo = tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : (el.type || 'text');
    if (['submit', 'button', 'image', 'reset', 'search'].includes(tipo)) continue;
    const sel = selDe(el);
    if (!sel) continue;
    const item = {
      sel, tipo,
      etiqueta: etiquetaDe(el),
      requerido: !!el.required || el.getAttribute('aria-required') === 'true',
      valor: el.value || '',
    };
    if (tipo === 'select') item.opciones = [...el.options].map(o => (o.text || '').trim()).filter(Boolean);
    out.push(item);
  }
  return out;
})()`;

// ---------------------------------------------------------------------------
// Driver.
// ---------------------------------------------------------------------------

const MAX_PASOS = 16;

export class IcimsDriver implements BrowserDriver {
  readonly portal = 'icims';

  private forwarder: net.Server | null = null;
  private browser: PwBrowser | null = null;
  private page: PwPage | null = null;
  private capturas: string[] = [];
  private rellenados = 0;

  private async pageActiva(job: DriverJob): Promise<PwPage> {
    if (this.page) return this.page;
    this.forwarder = await startForwarder();
    const chromium = cargarPlaywright();
    this.browser = await chromium.launch({
      executablePath: resolveChromiumExe(),
      headless: true,
      ...(this.forwarder ? { proxy: { server: 'http://127.0.0.1:18080' } } : {}),
      args: ['--ignore-certificate-errors', '--no-sandbox', '--disable-dev-shm-usage'],
    });
    this.page = await this.browser.newPage({ viewport: { width: 1360, height: 1000 } });
    mkdirSync(job.shotsDir, { recursive: true });
    return this.page;
  }

  private async texto(page: PwPage): Promise<string> {
    return page.evaluate<string>('document.body.innerText');
  }

  private async foto(page: PwPage, job: DriverJob, nombre: string): Promise<void> {
    const ruta = join(job.shotsDir, nombre);
    await page.screenshot({ path: ruta }).catch(() => {});
    this.capturas.push(ruta);
  }

  private async captchaVisible(page: PwPage): Promise<string[]> {
    return page.evaluate<string[]>(HCAPTCHA_CHALLENGE_JS).catch(() => []);
  }

  private async botonVisible(page: PwPage, nombre: RegExp): Promise<PwLocator | null> {
    for (const role of ['button', 'link'] as const) {
      const loc = page.getByRole(role, { name: nombre }).first();
      if (await loc.isVisible().catch(() => false)) return loc;
    }
    return null;
  }

  async verificarApertura(job: DriverJob): Promise<AperturaResultado> {
    const page = await this.pageActiva(job);
    let resp: { status(): number } | null = null;
    try {
      resp = await page.goto(job.applyUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (err) {
      throw new AnomaliaEnvio(
        'error_ambiguo',
        `no se pudo cargar la oferta: ${err instanceof Error ? err.message : 'error desconocido'}`,
      );
    }
    await page.waitForTimeout(3500);
    const httpStatus = resp ? resp.status() : null;
    if (httpStatus !== null && httpStatus >= 400) {
      return { abierta: false, detalle: `HTTP ${httpStatus} al abrir la oferta` };
    }
    const text = await this.texto(page);
    if (CLOSED_RE.test(text)) {
      return { abierta: false, detalle: 'la página indica que la oferta está cerrada' };
    }
    const enIcims = /icims\.com/i.test(page.url());
    const applyBtn = enIcims ? null : await this.botonVisible(page, /apply|aplicar|postular/i);
    if (!enIcims && !applyBtn) {
      return { abierta: false, detalle: 'sin botón de aplicación visible en la página de la oferta' };
    }
    return {
      abierta: true,
      detalle: enIcims
        ? 'página del portal iCIMS cargada, sin señales de cierre'
        : 'oferta abierta con botón de aplicación visible (deriva a iCIMS)',
    };
  }

  /** Desde la página de la oferta hasta el asistente de iCIMS. */
  private async entrarAlAsistente(page: PwPage, job: DriverJob): Promise<void> {
    if (/icims\.com/i.test(page.url())) return;
    const applyBtn = await this.botonVisible(page, /apply|aplicar|postular/i);
    if (!applyBtn) {
      throw new AnomaliaEnvio('formulario_cambiado', 'no se encuentra el botón de aplicación en la página de la oferta', {
        contexto: { fase: 'icims_entrada', url: page.url() },
      });
    }
    await applyBtn.scrollIntoViewIfNeeded().catch(() => {});
    await applyBtn.click();
    try {
      await page.waitForURL(/icims\.com/i, { timeout: 30000 });
    } catch {
      // Puede tardar o abrir en la misma URL con redirección JS.
      await page.waitForTimeout(3000);
      if (!/icims\.com/i.test(page.url())) {
        await this.foto(page, job, 'icims-sin-redireccion.png');
        throw new AnomaliaEnvio('formulario_cambiado', `tras pulsar Apply no se llegó a iCIMS (URL: ${page.url()})`, {
          contexto: { fase: 'icims_entrada', url: page.url() },
        });
      }
    }
    await page.waitForTimeout(2500);
  }

  /** Pantalla de acceso: email + aceptación de privacidad → Next. */
  private async pasoAcceso(page: PwPage, job: DriverJob, campos: CampoDescubierto[]): Promise<boolean> {
    const emailCampo = campos.find(
      (c) => c.tipo === 'email' || /e-?mail/i.test(c.etiqueta) || /email/i.test(c.sel),
    );
    if (!emailCampo) return false;
    const text = await this.texto(page);
    const esAcceso = /enter your information|privacy statement|sign in|log in|welcome/i.test(text);
    if (!esAcceso) return false;
    const datos = job.icims!;
    if (!emailCampo.valor) {
      await page.fill(emailCampo.sel, datos.cuentaEmail);
      this.rellenados++;
    }
    // Contraseña si la pantalla es de acceso con cuenta existente.
    const passCampo = campos.find((c) => c.tipo === 'password');
    if (passCampo && !passCampo.valor) {
      await page.fill(passCampo.sel, datos.cuentaPassword);
      this.rellenados++;
    }
    // Casilla de aceptación de la privacidad («I accept»).
    const checks = campos.filter((c) => c.tipo === 'checkbox');
    for (const chk of checks) {
      if (/accept|agree|privacy|consent/i.test(chk.etiqueta)) {
        await page.locator(chk.sel).check().catch(() => {});
      }
    }
    const next = await this.botonVisible(page, /next|continue|sign in|log in|create account/i);
    if (next) {
      await next.click();
      await page.waitForTimeout(3500);
      return true;
    }
    return false;
  }

  /** Pantalla de creación de cuenta: contraseñas → continuar. */
  private async pasoCrearCuenta(page: PwPage, job: DriverJob, campos: CampoDescubierto[]): Promise<boolean> {
    const passes = campos.filter((c) => c.tipo === 'password');
    if (passes.length === 0) return false;
    const text = await this.texto(page);
    if (!/create|register|new password|set (a )?password/i.test(text) && passes.length < 2) return false;
    for (const p of passes) {
      if (!p.valor) {
        await page.fill(p.sel, job.icims!.cuentaPassword);
        this.rellenados++;
      }
    }
    const btn = await this.botonVisible(page, /next|continue|create|register|save/i);
    if (btn) {
      await btn.click();
      await page.waitForTimeout(3500);
      return true;
    }
    return false;
  }

  /**
   * Rellena un paso del formulario por etiquetas. Devuelve el número de
   * campos rellenados/subidos; lanza anomalía si una pregunta
   * obligatoria no tiene respuesta determinada.
   */
  private async rellenarPaso(page: PwPage, job: DriverJob, campos: CampoDescubierto[]): Promise<number> {
    const d = job.icims!;
    let hechos = 0;
    const ciudad = d.ubicacion.includes(',') ? d.ubicacion.split(',')[0].trim() : d.ubicacion;
    const valorPara = (c: CampoDescubierto): string | null => {
      const e = `${c.etiqueta} ${c.sel}`.toLowerCase();
      if (/first ?name|given name|nombre/.test(e)) return d.nombre;
      if (/last ?name|family name|surname|apellido/.test(e)) return d.apellidos;
      if (/e-?mail/.test(e)) return d.email;
      if (/phone|mobile|telephone|teléfono|telefono/.test(e)) return d.telefono || null;
      if (/linkedin/.test(e)) return d.linkedin || null;
      if (/city|ciudad/.test(e)) return ciudad;
      if (/country|país|pais/.test(e)) return d.paisResidencia;
      return null;
    };

    for (const c of campos) {
      if (c.tipo === 'file') {
        const etiqueta = c.etiqueta.toLowerCase();
        const esCarta = /cover|presentación|presentacion/.test(etiqueta);
        const esCv = /resume|cv|curriculum|currículum/.test(etiqueta);
        const ruta = esCarta ? job.cartaPath : esCv ? job.cvPath : job.cvPath;
        if (!existsSync(ruta)) {
          throw new AnomaliaEnvio('datos_ausentes', `documento no encontrado en disco: ${ruta}`);
        }
        try {
          await page.locator(c.sel).setInputFiles(ruta);
          hechos++;
          this.rellenados++;
          await page.waitForTimeout(1200);
        } catch {
          // Input de fichero no estándar: se anota y se sigue; la
          // revisión final mostraría si faltaba un documento exigido.
        }
        continue;
      }
      if (c.tipo === 'checkbox' || c.tipo === 'radio') {
        if (!c.requerido) continue;
        if (/accept|agree|privacy|consent|certify/i.test(c.etiqueta)) {
          await page.locator(c.sel).check().catch(() => {});
          hechos++;
        }
        continue;
      }
      if (c.valor && c.valor.trim() !== '') continue; // ya relleno
      if (c.tipo === 'select') {
        const opts = c.opciones ?? [];
        const buscado = valorPara(c);
        const match = buscado
          ? opts.find((o) => o.toLowerCase() === buscado.toLowerCase()) ??
            opts.find((o) => o.toLowerCase().includes(buscado.toLowerCase()))
          : undefined;
        if (match) {
          await page.locator(c.sel).selectOption({ label: match }).catch(() => {});
          hechos++;
          this.rellenados++;
          continue;
        }
        const decline = opts.find((o) => /decline|prefer not|not (to )?say|no deseo|prefiero no/i.test(o));
        if (decline) {
          await page.locator(c.sel).selectOption({ label: decline }).catch(() => {});
          hechos++;
          this.rellenados++;
          continue;
        }
        if (c.requerido) {
          throw new AnomaliaEnvio(
            'datos_ausentes',
            `pregunta sin respuesta determinada en iCIMS: «${c.etiqueta}» (opciones: ${opts.slice(0, 8).join(' | ')})`,
            { contexto: { fase: 'icims_formulario', campo: c.etiqueta, selector: c.sel } },
          );
        }
        continue;
      }
      // text / email / tel / textarea / date
      const v = valorPara(c);
      if (v) {
        await page.fill(c.sel, v).catch(() => {});
        hechos++;
        this.rellenados++;
        continue;
      }
      const e = `${c.etiqueta} ${c.sel}`.toLowerCase();
      if (/address|dirección|direccion|street/.test(e) && c.requerido) {
        throw new AnomaliaEnvio('datos_ausentes', `iCIMS pide la dirección postal («${c.etiqueta}») y no está en el perfil`, {
          contexto: { fase: 'icims_formulario', campo: c.etiqueta },
        });
      }
      if (/postal|zip/.test(e) && c.requerido) {
        throw new AnomaliaEnvio('datos_ausentes', `iCIMS pide el código postal («${c.etiqueta}») y no está en el perfil`, {
          contexto: { fase: 'icims_formulario', campo: c.etiqueta },
        });
      }
      if (/salary|salario|expectativa/.test(e) && c.requerido) {
        throw new AnomaliaEnvio('datos_ausentes', `iCIMS pide expectativas salariales («${c.etiqueta}»): no se inventan cifras`, {
          contexto: { fase: 'icims_formulario', campo: c.etiqueta },
        });
      }
      if (c.requerido && c.tipo !== 'date') {
        throw new AnomaliaEnvio(
          'datos_ausentes',
          `campo obligatorio sin respuesta determinada en iCIMS: «${c.etiqueta || c.sel}»`,
          { contexto: { fase: 'icims_formulario', campo: c.etiqueta, selector: c.sel } },
        );
      }
    }
    return hechos;
  }

  async preparar(job: DriverJob): Promise<PreparacionResultado> {
    const page = await this.pageActiva(job);
    if (!job.icims) {
      throw new AnomaliaEnvio('datos_ausentes', 'trabajo iCIMS sin datos de candidato/cuenta');
    }
    await this.entrarAlAsistente(page, job);

    for (let paso = 0; paso < MAX_PASOS; paso++) {
      await this.foto(page, job, `icims-paso-${paso}.png`);
      const captcha = await this.captchaVisible(page);
      if (captcha.length > 0) {
        await this.foto(page, job, 'icims-captcha.png');
        throw new AnomaliaEnvio('captcha_mfa', `hCaptcha con desafío visible en iCIMS: ${captcha.join(' | ')}`, {
          contexto: { fase: 'icims', paso, url: page.url() },
        });
      }
      const text = await this.texto(page);
      if (SUCCESS_RE.test(text) && paso > 0) break; // ya enviado en un paso previo
      if (
        /verify your email|verification code|enter the code|check your (email|inbox)|hemos enviado| código de verificación/i.test(
          text,
        )
      ) {
        await this.foto(page, job, 'icims-verificacion.png');
        throw new AnomaliaEnvio(
          'captcha_mfa',
          'iCIMS pide una verificación por correo para continuar: es un paso pensado para la persona (código/enlace en su bandeja). Todo lo rellenado hasta aquí queda en la cuenta creada.',
          { contexto: { fase: 'icims', paso, url: page.url() } },
        );
      }
      const campos = await page.evaluate<CampoDescubierto[]>(DESCUBRIR_CAMPOS_JS);

      if (await this.pasoAcceso(page, job, campos)) continue;
      if (await this.pasoCrearCuenta(page, job, campos)) continue;

      // ¿Pantalla de revisión con botón de envío? La gestiona enviarYConfirmar.
      const submit = await this.botonVisible(page, /submit|send application|apply now|enviar/i);
      const hayCampos = campos.some((c) => c.tipo !== 'checkbox' && c.tipo !== 'radio');
      if (submit && !hayCampos) break;
      if (submit && /review|revisa|summary|resumen/i.test(text)) break;

      const hechos = await this.rellenarPaso(page, job, campos);
      const next = await this.botonVisible(page, /next|continue|save|guardar|seguir/i);
      if (next) {
        await next.click();
        await page.waitForTimeout(3500);
        continue;
      }
      if (hechos === 0 && !submit) {
        await this.foto(page, job, 'icims-atascado.png');
        throw new AnomaliaEnvio(
          'formulario_cambiado',
          `paso de iCIMS sin campos rellenables ni botón de avance (URL: ${page.url()})`,
          { contexto: { fase: 'icims', paso, url: page.url() } },
        );
      }
      if (submit) break;
    }
    await this.foto(page, job, 'icims-listo.png');
    return { camposRellenados: this.rellenados, uploadsOk: true, capturas: [...this.capturas] };
  }

  async enviarYConfirmar(job: DriverJob): Promise<ResultadoDriver> {
    const page = await this.pageActiva(job);
    const submit = await this.botonVisible(page, /submit|send application|apply now|enviar/i);
    if (!submit) {
      return {
        confirmado: false,
        capturas: [...this.capturas],
        evidencia: { motivo: 'sin botón de envío en la pantalla final de iCIMS', url: page.url() },
      };
    }
    await submit.scrollIntoViewIfNeeded().catch(() => {});
    await submit.click();
    let detectada = false;
    try {
      await page.waitForFunction(
        `(reSrc) => new RegExp(reSrc, 'i').test(document.body.innerText)`,
        SUCCESS_RE.source,
        { timeout: 60000, polling: 1000 },
      );
      detectada = true;
    } catch {
      detectada = false;
    }
    await page.waitForTimeout(2500);
    const urlTrasEnvio = page.url();
    const postText = await this.texto(page);
    const ok = detectada || SUCCESS_RE.test(postText);
    await this.foto(page, job, 'icims-confirmacion.png');
    const captchaPost = await this.captchaVisible(page);
    if (captchaPost.length > 0 && !ok) {
      throw new AnomaliaEnvio('captcha_mfa', `hCaptcha visible tras pulsar Submit en iCIMS: ${captchaPost.join(' | ')}`, {
        trasClick: true,
        contexto: { fase: 'icims_enviar', url: urlTrasEnvio },
      });
    }
    const refMatch = postText.match(/(confirmation|application|reference|submission)\s*(id|number|no\.?|#)?\s*[:#]?\s*([A-Za-z0-9-]{4,40})/i);
    const confirmacion: ConfirmacionEnvio = {
      mensaje: postText.slice(0, 2000),
      urlTrasEnvio,
      referencia: refMatch ? refMatch[0].slice(0, 120) : null,
      capturas: [...this.capturas],
    };
    if (!ok) {
      return {
        confirmado: false,
        capturas: [...this.capturas],
        evidencia: { urlTrasEnvio, motivo: 'sin confirmación tras Submit en iCIMS' },
      };
    }
    return {
      confirmado: true,
      confirmacion,
      capturas: [...this.capturas],
      evidencia: { urlTrasEnvio, referencia: confirmacion.referencia },
    };
  }

  async cerrar(): Promise<void> {
    if (this.browser) {
      try {
        await this.browser.close();
      } finally {
        this.browser = null;
        this.page = null;
      }
    }
    if (this.forwarder) {
      try {
        this.forwarder.close();
      } catch {
        // cierre best-effort
      }
      this.forwarder = null;
    }
  }
}
