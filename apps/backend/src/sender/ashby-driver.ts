/**
 * Driver de navegador para Ashby (jobs.ashbyhq.com).
 *
 * Flujo real (verificado en vivo el 2026-10-22 con la bolsa de
 * Possible Finance): el formulario vive en `<url-del-puesto>/application`,
 * SIN cuenta de candidato. Campos de sistema con nombres estables
 * (`_systemfield_name`, `_systemfield_email`, `_systemfield_phone`),
 * subida de CV («Resume»), preguntas de la empresa con etiquetas
 * reales (textos libres, numéricas, Sí/No como BOTONES y desplegables)
 * y reCAPTCHA invisible (solo se para si aparece un desafío visible).
 *
 * Honestidad (la misma disciplina que iCIMS/Workable/Workday):
 *  - Autorización de trabajo: la verdad del perfil según el país del
 *    puesto (zona España/UE de Jon); patrocinio, la inversa.
 *  - Sueldo: solo el hecho `salary_expectation` de su perfil (en
 *    campos numéricos, su cifra); sin hecho, parada `datos_ausentes`.
 *  - Preguntas de texto libre sin respuesta determinada en el perfil
 *    («What excites you about…»): parada `datos_ausentes` nombrando
 *    la pregunta exacta — jamás se inventa una redacción.
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

interface PwElementHandle {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  evaluate<R>(fn: string | ((el: any, arg?: any) => R), arg?: unknown): Promise<R>;
}

interface PwFrame {
  url(): string;
  evaluate<R>(fn: string): Promise<R>;
  $(selector: string): Promise<PwElementHandle | null>;
  $$(selector: string): Promise<PwElementHandle[]>;
  click(selector: string, opts?: { timeout?: number; position?: { x: number; y: number } }): Promise<void>;
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

const TEXTO_JS = `(function () { return document.body ? (document.body.innerText || '') : ''; })()`;

const CLOSED_RE =
  /job not found|the job you requested was not found|position (has been )?filled|no longer (accepting|available)|this (job|position|posting) (is )?closed|ya no acepta|puesto (cerrado|ya no disponible)/i;

const SUCCESS_RE =
  /application submitted|thank you for applying|your application has been (received|submitted)|we('ve| have) received your application|successfully submitted|gracias por (aplicar|postularte)/i;

/** Zonas donde Jon tiene derecho de trabajo (España/UE), en minúsculas. */
const ZONA_DERECHO = [
  'spain', 'españa', 'espana', 'germany', 'alemania', 'france', 'francia',
  'italy', 'italia', 'portugal', 'netherlands', 'holanda', 'belgium', 'bélgica',
  'ireland', 'irlanda', 'austria', 'poland', 'polonia', 'sweden', 'suecia',
  'denmark', 'dinamarca', 'finland', 'finlandia', 'european union', 'unión europea',
  'madrid', 'barcelona', 'valencia', 'sevilla', 'bilbao', 'logroño', 'logrono',
];

interface CampoA {
  sel: string;
  tipo: string;
  name: string;
  etiqueta: string;
  requerido: boolean;
  valor: string;
}

const DESCUBRIR_JS = `(function () {
  var out = [];
  var nodes = document.querySelectorAll('input, select, textarea');
  for (var i = 0; i < nodes.length; i++) {
    var e = nodes[i];
    var tipo = (e.getAttribute('type') || e.tagName).toLowerCase();
    if (tipo === 'hidden' || tipo === 'submit' || tipo === 'button') continue;
    if (e.name === 'g-recaptcha-response') continue;
    if (tipo !== 'file' && !(e.offsetWidth || e.offsetHeight)) continue;
    var etiqueta = '';
    if (e.id) {
      var lab = document.querySelector('label[for="' + CSS.escape(e.id) + '"]');
      if (lab) etiqueta = (lab.textContent || '').trim();
    }
    if (!etiqueta) {
      var wrap = e.closest('label');
      if (wrap) etiqueta = (wrap.textContent || '').trim();
    }
    if (!etiqueta) etiqueta = e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.name || '';
    var requerido = !!e.required || e.getAttribute('aria-required') === 'true' || /\\*/.test(etiqueta);
    // Selector estable: por name si existe; si no, por id.
    var sel = null;
    if (e.name) sel = e.tagName.toLowerCase() + '[name="' + e.name.replace(/"/g, '') + '"]';
    else if (e.id) sel = '#' + CSS.escape(e.id);
    if (!sel) continue;
    out.push({
      sel: sel,
      tipo: tipo,
      name: e.name || '',
      etiqueta: etiqueta.replace(/\\s+/g, ' ').slice(0, 180),
      requerido: requerido,
      valor: e.value || '',
    });
  }
  return out;
})()`;

export class AshbyDriver implements BrowserDriver {
  readonly portal = 'ashby';
  private browser: PwBrowser | null = null;
  private page: PwPage | null = null;
  private forwarder: import('node:net').Server | null = null;

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
      // Ya cerrado.
    }
    this.forwarder = null;
  }

  private urlFormulario(job: DriverJob): string {
    const base = job.applyUrl.replace(/\/+$/, '');
    return base.endsWith('/application') ? base : `${base}/application`;
  }

  private async capturar(page: PwPage, job: DriverJob, nombre: string): Promise<string> {
    const ruta = join(job.shotsDir, nombre);
    await page.screenshot({ path: ruta, fullPage: true }).catch(() => undefined);
    return ruta;
  }

  /** ¿Desafío de reCAPTCHA VISIBLE? (el invisible v3 no cuenta). */
  private async captchaVisible(page: PwPage): Promise<boolean> {
    for (const frame of page.frames()) {
      const url = frame.url();
      if (/recaptcha\/(api2\/bframe|enterprise\/bframe)/.test(url)) {
        const tieneDesafio = await frame
          .evaluate<boolean>(
            `(function () { return !!document.querySelector('.rc-imageselect, .rc-doscaptcha, #rc-imageselect'); })()`,
          )
          .catch(() => false);
        if (tieneDesafio) return true;
      }
    }
    return false;
  }

  async verificarApertura(job: DriverJob): Promise<AperturaResultado> {
    const page = await this.pageActiva(job);
    let resp: { status(): number } | null = null;
    try {
      resp = await page.goto(this.urlFormulario(job), {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
    } catch (e) {
      return {
        abierta: false,
        detalle: `error de red abriendo Ashby: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    await page.waitForTimeout(4500);
    const status = resp?.status();
    if (status !== undefined && status >= 400) {
      return { abierta: false, detalle: `HTTP ${status} al abrir el formulario de Ashby` };
    }
    const texto = await page.evaluate<string>(TEXTO_JS).catch(() => '');
    if (CLOSED_RE.test(texto)) {
      return { abierta: false, detalle: 'la oferta figura cerrada en Ashby («Job not found» o similar)' };
    }
    const campos = await page.evaluate<CampoA[]>(DESCUBRIR_JS).catch(() => [] as CampoA[]);
    if (campos.length === 0) {
      return { abierta: false, detalle: `formulario de Ashby no detectado (URL: ${page.url()})` };
    }
    return { abierta: true, detalle: 'formulario de Ashby accesible (sin cuenta)' };
  }

  /** País del puesto según el texto inicial de la propia página. */
  private async enZonaDerecho(page: PwPage): Promise<boolean> {
    const texto = (await page.evaluate<string>(TEXTO_JS).catch(() => '')).toLowerCase();
    const cabecera = texto.split('\n').slice(0, 14).join(' ');
    return ZONA_DERECHO.some((z) => cabecera.includes(z));
  }

  async preparar(
    job: DriverJob,
  ): Promise<{ camposRellenados: number; uploadsOk: boolean; capturas: string[] }> {
    const page = await this.pageActiva(job);
    const d = job.etiquetas;
    if (!d) {
      throw new AnomaliaEnvio('datos_ausentes', 'trabajo Ashby sin datos de perfil');
    }
    if (page.url() !== this.urlFormulario(job)) {
      await page.goto(this.urlFormulario(job), { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(4000);
    }
    if (await this.captchaVisible(page)) {
      throw new AnomaliaEnvio(
        'captcha_mfa',
        'desafío de reCAPTCHA visible en Ashby: queda para resolverlo tú',
        { trasClick: false },
      );
    }
    const capturas: string[] = [await this.capturar(page, job, 'ashby-formulario.png')];
    const zonaDerecho = await this.enZonaDerecho(page);
    let tocados = 0;

    // --- Subidas primero (Ashby parsea el CV y puede re-renderizar) --
    let campos = await page.evaluate<CampoA[]>(DESCUBRIR_JS);
    let uploadsOk = false;
    for (const c of campos) {
      if (c.tipo !== 'file') continue;
      const esCarta = /cover|letter|carta/.test(c.etiqueta.toLowerCase());
      try {
        await page.setInputFiles(c.sel, esCarta ? job.cartaPath : job.cvPath);
        if (!esCarta) uploadsOk = true;
        tocados++;
      } catch {
        // Input no operable; si es el CV se anota abajo.
      }
    }
    if (!uploadsOk) {
      throw new AnomaliaEnvio(
        'formulario_cambiado',
        'no se pudo subir el CV al formulario de Ashby (input de fichero no operable)',
      );
    }
    await page.waitForTimeout(3500);
    campos = await page.evaluate<CampoA[]>(DESCUBRIR_JS);

    // --- Campos de texto/select por nombre y etiqueta ----------------
    const nombreCompleto = `${d.nombre} ${d.apellidos}`.trim();
    for (const c of campos) {
      if (c.tipo === 'file' || c.tipo === 'radio' || c.tipo === 'checkbox') continue;
      const e = c.etiqueta.toLowerCase();
      const n = c.name.toLowerCase();
      let valor: string | null = null;
      if (n === '_systemfield_name' || (/^name$|full name|nombre completo/.test(e) && !/company|empresa/.test(e))) {
        valor = nombreCompleto;
      } else if (n === '_systemfield_email' || c.tipo === 'email' || /e-?mail|correo/.test(e)) {
        valor = d.email;
      } else if (n === '_systemfield_phone' || /phone|tel[eé]fono|mobile|móvil/.test(e)) {
        valor = d.telefono || null;
      } else if (/linkedin/.test(e)) {
        valor = d.linkedin || null;
      } else if (/salary|salario|compensation|pay expectation|remuneration/.test(e)) {
        if (!d.salarioEsperado) {
          if (c.requerido) {
            throw new AnomaliaEnvio(
              'datos_ausentes',
              `Ashby pide una cifra obligatoria que no invento: «${c.etiqueta}» — dime tu sueldo esperado y lo dejo en tu perfil`,
            );
          }
          continue;
        }
        valor =
          c.tipo === 'number'
            ? (d.salarioEsperado.replace(/[^\d]/g, '') || d.salarioEsperado)
            : d.salarioEsperado;
      } else if (/based in|currently located|city and country|where (are you|do you) (located|live)|ubicaci[oó]n actual|ciudad y pa[ií]s/.test(e)) {
        valor = d.ubicacion || null;
      } else if (/website|portfolio|github/.test(e)) {
        valor = null; // Sin dato en el perfil: no se inventa.
      }
      if (valor) {
        if (c.tipo === 'select') {
          await page
            .evaluate<boolean>(
              `(function () {
                var el = document.querySelector(${JSON.stringify(c.sel)});
                if (!el) return false;
                var objetivo = ${JSON.stringify(valor)}.toLowerCase();
                for (var i = 0; i < el.options.length; i++) {
                  if ((el.options[i].text || '').trim().toLowerCase() === objetivo) {
                    el.value = el.options[i].value;
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                  }
                }
                return false;
              })()`,
            )
            .catch(() => false);
          tocados++;
        } else {
          await page.fill(c.sel, valor).catch(() => undefined);
          tocados++;
        }
      } else if (c.requerido && (c.tipo === 'text' || c.tipo === 'textarea' || c.tipo === 'url' || c.tipo === 'number')) {
        throw new AnomaliaEnvio(
          'datos_ausentes',
          `pregunta obligatoria de Ashby sin respuesta determinada en tu perfil: «${c.etiqueta}» — dímela y la aplico`,
        );
      }
    }

    // --- Preguntas Sí/No (botones de Ashby) ---------------------------
    await this.responderBotonesSiNo(page, zonaDerecho);

    // --- Verificación de obligatorios ---------------------------------
    const tras = await page.evaluate<CampoA[]>(DESCUBRIR_JS);
    const pendiente = tras.find(
      (c) =>
        c.requerido &&
        (c.tipo === 'text' || c.tipo === 'email' || c.tipo === 'textarea' || c.tipo === 'url' || c.tipo === 'number') &&
        (!c.valor || c.valor.trim() === '') &&
        !/cover|letter|carta/.test(c.etiqueta.toLowerCase()),
    );
    if (pendiente) {
      throw new AnomaliaEnvio(
        'datos_ausentes',
        `campo obligatorio de Ashby sin respuesta en tu perfil: «${pendiente.etiqueta}»`,
      );
    }
    capturas.push(await this.capturar(page, job, 'ashby-relleno.png'));
    return { camposRellenados: tocados, uploadsOk, capturas };
  }

  /**
   * Las preguntas booleanas de Ashby son pares de botones «Yes»/«No»
   * junto a la pregunta. Se contestan SOLO las familias con respuesta
   * determinada (autorización/patrocinio); el resto queda sin tocar y
   * la verificación de obligatorios decide.
   */
  private async responderBotonesSiNo(page: PwPage, zonaDerecho: boolean): Promise<void> {
    const familias: Array<{ patron: RegExp; respuesta: boolean }> = [
      {
        patron: /authorized to work|right to work|eligible to work|legally (allowed|eligible) to work|autorizaci[oó]n para trabajar/i,
        respuesta: zonaDerecho,
      },
      {
        patron: /require (visa )?sponsorship|need sponsorship|patrocinio de (visa|visado)/i,
        respuesta: !zonaDerecho,
      },
      { patron: /18 years of age|over (the age of )?18|mayor de edad/i, respuesta: true },
    ];
    for (const fam of familias) {
      await page
        .evaluate<boolean>(
          `(function () {
            function norm(s) { return (s || '').replace(/\\s+/g, ' ').trim(); }
            var patron = ${fam.patron.toString()};
            var objetivo = ${fam.respuesta ? "'yes'" : "'no'"};
            var labels = document.querySelectorAll('label, legend, [class*="question"], div, fieldset');
            for (var i = 0; i < labels.length; i++) {
              var el = labels[i];
              var t = norm(el.textContent);
              if (t.length > 220 || !patron.test(t)) continue;
              var scope = el.closest('fieldset, div') || el;
              var btns = scope.querySelectorAll('button');
              for (var j = 0; j < btns.length; j++) {
                if (norm(btns[j].textContent).toLowerCase() === objetivo) { btns[j].click(); return true; }
              }
            }
            return false;
          })()`,
        )
        .catch(() => false);
    }
  }

  async enviarYConfirmar(job: DriverJob): Promise<ResultadoDriver> {
    const page = await this.pageActiva(job);
    const capturas: string[] = [];
    const pulsado = await page
      .evaluate<boolean>(`(function () {
        var bs = document.querySelectorAll('button, input[type="submit"]');
        for (var i = 0; i < bs.length; i++) {
          var t = ((bs[i].textContent || bs[i].value || '')).trim().toLowerCase();
          if (t === 'submit application' || t === 'submit' || t === 'enviar solicitud') {
            bs[i].click();
            return true;
          }
        }
        return false;
      })()`)
      .catch(() => false);
    if (!pulsado) {
      throw new AnomaliaEnvio(
        'formulario_cambiado',
        `no se encontró el botón «Submit Application» en Ashby (URL: ${page.url()})`,
      );
    }
    for (let espera = 0; espera < 10; espera++) {
      await page.waitForTimeout(3000);
      const textoSon = await page.evaluate<string>(TEXTO_JS).catch(() => '');
      if (SUCCESS_RE.test(textoSon)) {
        capturas.push(await this.capturar(page, job, 'ashby-tras-envio.png'));
        return {
          confirmado: true,
          confirmacion: {
            mensaje: 'Ashby confirmó la recepción de la candidatura.',
            urlTrasEnvio: page.url(),
            referencia: null,
            capturas,
          },
          capturas,
          evidencia: { portal: 'ashby' },
        };
      }
      if (await this.captchaVisible(page)) {
        capturas.push(await this.capturar(page, job, 'ashby-tras-envio.png'));
        throw new AnomaliaEnvio(
          'captcha_mfa',
          'desafío de reCAPTCHA visible tras pulsar Enviar en Ashby: el envío puede no haberse completado',
          { trasClick: true },
        );
      }
    }
    capturas.push(await this.capturar(page, job, 'ashby-tras-envio.png'));
    return { confirmado: false, capturas, evidencia: { portal: 'ashby' } };
  }
}
