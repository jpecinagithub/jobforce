/**
 * @jobforce/backend — Driver de navegador para Personio (ejecutor de envíos).
 *
 * Adaptación como módulo reutilizable del flujo probado en vivo en Fase 3
 * (`~/workspace/jobforce/fase3/submit_application.mjs`: 10/10 pasos OK,
 * envío real a HomeToGo con confirmación capturada).
 *
 * Red (lecciones en `~/AGENTS.md`): el proxy de egress hace interceptación
 * TLS; Chromium va detrás de un forwarder TCP local en 127.0.0.1:18080 que
 * inyecta `Proxy-Authorization` con las credenciales de las variables de
 * entorno (nunca en flags ni logs), más `--ignore-certificate-errors`.
 * El forwarder se cierra siempre al terminar.
 *
 * `playwright-core` se carga de forma dinámica (no hay import estático) para
 * que el resto del backend y los tests no dependan de él; en producción se
 * resuelve desde `node_modules` (declarado en `apps/backend/package.json`;
 * requiere `pnpm install` en un entorno con pnpm).
 *
 * Portales distintos de Personio: NO implementados. `crearDriver` lanza
 * `AnomaliaEnvio('portal_no_soportado')` en vez de simular nada.
 */

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
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
// Superficie mínima de playwright-core que usa el driver (tipos locales para
// no necesitar el paquete en tiempo de compilación).
// ---------------------------------------------------------------------------

interface PwLocator {
  isVisible(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  click(): Promise<void>;
  scrollIntoViewIfNeeded(): Promise<void>;
}

interface PwPage {
  goto(url: string, opts?: Record<string, unknown>): Promise<{ status(): number } | null>;
  evaluate<T>(fn: string | ((...args: never[]) => T), arg?: unknown): Promise<T>;
  fill(selector: string, value: string): Promise<void>;
  selectOption(selector: string, value: { label: string }): Promise<string[]>;
  setInputFiles(selector: string, files: string | string[]): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  waitForFunction(
    fn: unknown,
    arg?: unknown,
    opts?: { timeout?: number; polling?: number },
  ): Promise<void>;
  screenshot(opts?: Record<string, unknown>): Promise<Buffer>;
  getByRole(role: string, opts?: { name: RegExp }): { first(): PwLocator };
  url(): string;
}

interface PwBrowser {
  newPage(opts?: Record<string, unknown>): Promise<PwPage>;
  close(): Promise<void>;
}

interface PwChromium {
  launch(opts: Record<string, unknown>): Promise<PwBrowser>;
}

export function cargarPlaywright(): PwChromium {
  // createRequire con __filename (CJS): resuelve 'playwright-core' desde
  // node_modules del backend tras `pnpm install` (o NODE_PATH en pruebas).
  const req = createRequire(__filename);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const pw = req('playwright-core') as { chromium?: PwChromium };
  if (!pw.chromium) {
    throw new AnomaliaEnvio('error_ambiguo', 'playwright-core no está instalado (requiere pnpm install)');
  }
  return pw.chromium;
}

// ---------------------------------------------------------------------------
// Señales (las mismas validadas en Fase 3).
// ---------------------------------------------------------------------------

const CLOSED_SIGNALS: RegExp[] = [
  /no longer accepting/i,
  /position (is|has been) closed/i,
  /applications are closed/i,
  /job (is|has been) filled/i,
  /this job (is|has been) closed/i,
  /nicht mehr verf[uü]gbar/i,
  /stelle (ist|wurde) besetzt/i,
];

const SUCCESS_SIGNALS = /thank you|vielen dank|application received|bewerbung erhalten|successfully submitted|erfolgreich/i;

// Solo cuentan los widgets CAPTCHA VISIBLES (iframes). Un "turnstileSiteKey"
// con valor undefined en el blob de config de Next.js NO es un desafío
// (lección de Fase 3: falso positivo del primer intento).
const VISIBLE_CAPTCHA_JS = `[...document.querySelectorAll("iframe")]
  .filter(f => /recaptcha|hcaptcha|turnstile|challenges\\.cloudflare/i.test(f.src || "") && f.offsetParent !== null)
  .map(f => (f.src || "").slice(0, 120))`;

// ---------------------------------------------------------------------------
// Forwarder TCP local (AGENTS.md): inyecta Proxy-Authorization del entorno.
// ---------------------------------------------------------------------------

export function startForwarder(): Promise<net.Server | null> {
  return new Promise((resolve, reject) => {
    const upstream =
      process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
    if (!upstream) {
      // Sin proxy en el entorno (p. ej. el contenedor de Oracle, con egreso
      // directo): no hay forwarder y Chromium navega sin proxy.
      resolve(null);
      return;
    }
    const u = new URL(upstream);
    const auth =
      'Basic ' +
      Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
    const server = net.createServer((clientSock) => {
      clientSock.on('error', () => {});
      clientSock.once('data', (first) => {
        const req = first.toString('latin1');
        const m = req.slice(0, req.indexOf('\r\n')).match(/^CONNECT\s+(\S+)\s+HTTP\/\d/i);
        if (!m) {
          clientSock.destroy();
          return;
        }
        const target = m[1];
        const up = net.connect(Number(u.port || 3128), u.hostname, () => {
          up.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${auth}\r\n\r\n`);
          let buf = Buffer.alloc(0);
          const onData = (chunk: Buffer) => {
            buf = Buffer.concat([buf, chunk]);
            if (buf.indexOf('\r\n\r\n') !== -1) {
              const status = buf.toString('latin1').split('\r\n')[0];
              up.off('data', onData);
              if (!/^HTTP\/\d(\.\d)?\s+200/i.test(status)) {
                try {
                  clientSock.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
                } catch {
                  /* noop */
                }
                clientSock.destroy();
                up.destroy();
                return;
              }
              clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
              up.pipe(clientSock);
              clientSock.pipe(up);
            }
          };
          up.on('data', onData);
        });
        up.on('error', () => clientSock.destroy());
      });
    });
    server.on('error', (err) => reject(err));
    server.listen(18080, '127.0.0.1', () => resolve(server));
  });
}

export function resolveChromiumExe(): string {
  // En el contenedor se fija el Chromium del sistema por variable de
  // entorno (mismo criterio que @jobforce/docs).
  const deEntorno = process.env.PLAYWRIGHT_CHROMIUM_EXE;
  if (deEntorno && existsSync(deEntorno)) return deEntorno;
  const base = join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(base)) {
    throw new AnomaliaEnvio('error_ambiguo', `Chromium no encontrado en ${base}`);
  }
  for (const dir of readdirSync(base).sort().reverse()) {
    const full = join(base, dir, 'chrome-linux64', 'chrome');
    if (existsSync(full)) return full;
  }
  throw new AnomaliaEnvio('error_ambiguo', 'Chromium no encontrado en ~/.cache/ms-playwright');
}

// ---------------------------------------------------------------------------
// Driver de Personio.
// ---------------------------------------------------------------------------

/** Selectores estándar de Personio (los custom_attribute_* varían por oferta). */
export const PERSONIO_DOC_CV_DEFAULT = '#doc-input-cv';
export const PERSONIO_DOC_CARTA_DEFAULT = '#doc-input-cover-letter';

/**
 * Construye la lista de campos para un formulario Personio estándar a partir
 * de valores aprobados. Los `custom_attribute_*` son específicos de cada
 * oferta: se pasan como `extras`.
 */
export function camposPersonioEstandar(
  valores: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    extras?: Array<{ selector: string; tipo: 'fill' | 'select'; valor: string; etiqueta: string }>;
  },
): import('./types.js').CampoFormulario[] {
  return [
    { selector: '#field-first_name', tipo: 'fill', valor: valores.firstName, etiqueta: 'nombre' },
    { selector: '#field-last_name', tipo: 'fill', valor: valores.lastName, etiqueta: 'apellidos' },
    { selector: '#field-email', tipo: 'fill', valor: valores.email, etiqueta: 'email' },
    { selector: '#field-phone', tipo: 'fill', valor: valores.phone, etiqueta: 'teléfono' },
    ...(valores.extras ?? []),
  ];
}

export class PersonioDriver implements BrowserDriver {
  readonly portal = 'personio';

  private forwarder: net.Server | null = null;
  private browser: PwBrowser | null = null;
  private page: PwPage | null = null;
  private capturas: string[] = [];

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

  private async textoPagina(page: PwPage): Promise<string> {
    // Cadena (no arrow function) para no necesitar los tipos DOM en compilación.
    return page.evaluate<string>('document.body.innerText');
  }

  private async foto(page: PwPage, job: DriverJob, nombre: string): Promise<string> {
    const ruta = join(job.shotsDir, nombre);
    await page.screenshot({ path: ruta });
    this.capturas.push(ruta);
    return ruta;
  }

  async verificarApertura(job: DriverJob): Promise<AperturaResultado> {
    const page = await this.pageActiva(job);
    let resp: { status(): number } | null = null;
    try {
      resp = await page.goto(job.applyUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (err) {
      throw new AnomaliaEnvio('error_ambiguo', `no se pudo cargar la página de solicitud: ${err instanceof Error ? err.message : 'error desconocido'}`);
    }
    await page.waitForTimeout(4000);
    const httpStatus = resp ? resp.status() : null;
    if (httpStatus !== 200) {
      return { abierta: false, detalle: `HTTP ${httpStatus} al abrir la oferta` };
    }
    const text = await this.textoPagina(page);
    const closedHit = CLOSED_SIGNALS.find((re) => re.test(text));
    if (closedHit) {
      return { abierta: false, detalle: `señal de cierre en la página: ${closedHit}` };
    }
    const captcha = await page.evaluate<string[]>(VISIBLE_CAPTCHA_JS);
    if (captcha.length > 0) {
      throw new AnomaliaEnvio('captcha_mfa', `CAPTCHA/MFA visible antes de rellenar: ${captcha.join(' | ')}`, {
        contexto: { fase: 'verificarApertura', widgets: captcha },
      });
    }
    const submitBtn = page.getByRole('button', { name: new RegExp(job.submitButtonName, 'i') }).first();
    const visible = await submitBtn.isVisible().catch(() => false);
    if (!visible) {
      return { abierta: false, detalle: 'botón de envío no visible: la oferta podría estar cerrada' };
    }
    return { abierta: true, detalle: `HTTP 200, sin señales de cierre, botón "${job.submitButtonName}" visible` };
  }

  async preparar(job: DriverJob): Promise<PreparacionResultado> {
    const page = await this.pageActiva(job);

    // 1) Rellenar campos.
    let rellenados = 0;
    for (const campo of job.campos) {
      try {
        if (campo.tipo === 'select') {
          await page.selectOption(campo.selector, { label: campo.valor });
        } else {
          await page.fill(campo.selector, campo.valor);
        }
        rellenados++;
      } catch (err) {
        await this.foto(page, job, 'anomalia-formulario.png');
        throw new AnomaliaEnvio(
          'formulario_cambiado',
          `no se pudo rellenar el campo "${campo.etiqueta}" (${campo.selector}): ${err instanceof Error ? err.message : 'error desconocido'}`,
          { contexto: { fase: 'preparar', campo: campo.etiqueta, selector: campo.selector } },
        );
      }
    }

    // 2) Subir documentos y esperar a que COMPLETEN.
    const subir = async (selector: string, ruta: string, etiqueta: string) => {
      for (const p of [ruta]) {
        if (!existsSync(p)) {
          throw new AnomaliaEnvio('datos_ausentes', `documento no encontrado en disco: ${p}`, {
            contexto: { fase: 'preparar', documento: etiqueta },
          });
        }
      }
      try {
        await page.setInputFiles(selector, ruta);
      } catch (err) {
        await this.foto(page, job, 'anomalia-subida.png');
        throw new AnomaliaEnvio(
          'formulario_cambiado',
          `no se pudo adjuntar ${etiqueta} (${selector}): ${err instanceof Error ? err.message : 'error desconocido'}`,
          { contexto: { fase: 'preparar', documento: etiqueta, selector } },
        );
      }
    };
    await subir(job.docCvSelector, job.cvPath, 'cv');
    await page.waitForTimeout(1500);
    await subir(job.docCartaSelector, job.cartaPath, 'carta');
    let uploadsOk = true;
    try {
      await page.waitForFunction(
        '![...document.body.innerText.matchAll(/uploading files\\.\\.\\./gi)].length',
        undefined,
        { timeout: 60000, polling: 1000 },
      );
    } catch {
      uploadsOk = false;
    }
    const docsShown = await page.evaluate<{ cv: boolean; carta: boolean }>(
      `(nombres) => {
        const t = document.body.innerText;
        const base = (p) => p.split('/').pop().toLowerCase();
        return { cv: t.toLowerCase().includes(base(nombres.cv)), carta: t.toLowerCase().includes(base(nombres.carta)) };
      }`,
      { cv: job.cvPath, carta: job.cartaPath },
    );
    if (!uploadsOk || !docsShown.cv || !docsShown.carta) {
      await this.foto(page, job, 'anomalia-subida.png');
      throw new AnomaliaEnvio(
        'error_ambiguo',
        `subidas sin confirmar (completas=${uploadsOk} cv=${docsShown.cv} carta=${docsShown.carta}): no se envía`,
        { contexto: { fase: 'preparar', uploadsOk, docsShown } },
      );
    }

    await this.foto(page, job, 'exec-pre-top.png');
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await page.waitForTimeout(800);
    await this.foto(page, job, 'exec-pre-bottom.png');

    // 3) Re-verificación justo antes de enviar.
    const text = await this.textoPagina(page);
    const closedLate = CLOSED_SIGNALS.find((re) => re.test(text));
    if (closedLate) {
      await this.foto(page, job, 'anomalia-cierre.png');
      throw new AnomaliaEnvio('oferta_cerrada', `la oferta se cerró durante el rellenado: ${closedLate}`, {
        contexto: { fase: 'preparar' },
      });
    }
    const captcha = await page.evaluate<string[]>(VISIBLE_CAPTCHA_JS);
    if (captcha.length > 0) {
      await this.foto(page, job, 'anomalia-captcha.png');
      throw new AnomaliaEnvio('captcha_mfa', `CAPTCHA/MFA visible antes de enviar: ${captcha.join(' | ')}`, {
        contexto: { fase: 'preparar', widgets: captcha },
      });
    }
    const submitBtn = page.getByRole('button', { name: new RegExp(job.submitButtonName, 'i') }).first();
    const enabled = await submitBtn.isEnabled().catch(() => false);
    if (!enabled) {
      await this.foto(page, job, 'anomalia-boton.png');
      throw new AnomaliaEnvio('error_ambiguo', 'el botón de envío sigue deshabilitado tras rellenar: bloqueo real, no se pulsa', {
        contexto: { fase: 'preparar' },
      });
    }
    return { camposRellenados: rellenados, uploadsOk: true, capturas: [...this.capturas] };
  }

  async enviarYConfirmar(job: DriverJob): Promise<ResultadoDriver> {
    const page = await this.pageActiva(job);
    const submitBtn = page.getByRole('button', { name: new RegExp(job.submitButtonName, 'i') }).first();
    await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
    await submitBtn.click();

    // Capturar confirmación: mensaje de éxito o cambio de URL.
    // (función como cadena: se serializa al navegador; evita tipos DOM aquí)
    let confirmacionDetectada = false;
    try {
      await page.waitForFunction(
        `(reSrc) => { const re = new RegExp(reSrc, 'i'); return re.test(document.body.innerText) || !/\\/apply(\\?|$)/i.test(location.href); }`,
        SUCCESS_SIGNALS.source,
        { timeout: 60000, polling: 1000 },
      );
      confirmacionDetectada = true;
    } catch {
      confirmacionDetectada = false;
    }
    await page.waitForTimeout(3000);
    const urlTrasEnvio = page.url();
    const postText = await this.textoPagina(page);
    const mensajeExito = SUCCESS_SIGNALS.test(postText);
    const refMatch = postText.match(/(reference|application)\s*(id|number|no\.?|#)?\s*[:#]?\s*([A-Za-z0-9-]{4,40})/i);
    const captchaPost = await page.evaluate<string[]>(VISIBLE_CAPTCHA_JS);
    await this.foto(page, job, 'exec-confirmation.png');

    const confirmacion: ConfirmacionEnvio = {
      mensaje: postText.slice(0, 2000),
      urlTrasEnvio,
      referencia: refMatch ? refMatch[0].slice(0, 120) : null,
      capturas: [...this.capturas],
    };

    if (captchaPost.length > 0 && !mensajeExito) {
      throw new AnomaliaEnvio(
        'captcha_mfa',
        `CAPTCHA/MFA visible tras pulsar Submit sin confirmación: ${captchaPost.join(' | ')}`,
        { trasClick: true, contexto: { fase: 'enviarYConfirmar', widgets: captchaPost, urlTrasEnvio } },
      );
    }
    if (!mensajeExito && !confirmacionDetectada) {
      // Se pulsó Submit pero no hay confirmación: estado INCIERTO.
      // No se reintenta: lo devuelve como no confirmado y el ejecutor concilia.
      return {
        confirmado: false,
        capturas: [...this.capturas],
        evidencia: { urlTrasEnvio, captchaPost, motivo: 'sin confirmación tras Submit' },
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
    const errs: unknown[] = [];
    if (this.browser) {
      try {
        await this.browser.close();
      } catch (e) {
        errs.push(e);
      }
      this.browser = null;
      this.page = null;
    }
    if (this.forwarder) {
      try {
        this.forwarder.close();
      } catch (e) {
        errs.push(e);
      }
      this.forwarder = null;
    }
    if (errs.length > 0) {
      throw errs[0];
    }
  }
}

/**
 * Factoría de drivers por portal. Solo Personio está implementado y probado
 * en vivo (Fase 3); cualquier otro portal lanza `portal_no_soportado` en vez
 * de simular un envío.
 */
export function crearDriver(portal: string): BrowserDriver {
  const p = portal.trim().toLowerCase();
  if (p === 'personio') return new PersonioDriver();
  throw new AnomaliaEnvio(
    'portal_no_soportado',
    `el portal "${portal}" no tiene driver probado (solo personio)`,
    { contexto: { portal } },
  );
}
