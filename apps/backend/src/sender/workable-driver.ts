/**
 * Driver de navegador para Workable (apply.workable.com).
 *
 * Flujo real (verificado en vivo el 2026-10-21 con la oferta de
 * Euromonitor 2D69E85A31): la página de la oferta tiene el formulario
 * completo en `<url>/apply/` — SIN cuenta de candidato y, en la
 * configuración vista, sin captcha visible. Campos estándar con ids
 * estables (firstname, lastname, email), subida del CV, carta
 * opcional y preguntas de la empresa (radios Sí/No y textos).
 *
 * Relleno por etiquetas/ids desde el perfil verificado. Reglas de
 * honestidad (las mismas que en iCIMS):
 *  - «Right to Work» (Sí/No): se responde con la verdad del perfil —
 *    SÍ solo si el puesto está en su zona de derecho de trabajo
 *    (España/UE, leído del propio encabezado de la oferta); NO en
 *    caso contrario. La candidatura se envía igualmente (la encargó
 *    Jon) y el NO queda visible en la evidencia.
 *  - Sueldo esperado: SOLO si existe el hecho `salary_expectation`
 *    en su perfil; sin él, parada `datos_ausentes` nombrando la
 *    pregunta — jamás se inventa una cifra.
 *  - Cualquier otra pregunta obligatoria sin respuesta determinada:
 *    parada `datos_ausentes` con su texto exacto.
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

// ---------------------------------------------------------------------------
// Descubrimiento de campos (marco principal; Workable no usa iframes
// para el formulario en la configuración verificada).
// ---------------------------------------------------------------------------

interface CampoW {
  sel: string;
  tipo: string;
  name: string;
  etiqueta: string;
  grupo: string;
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
    if (tipo !== 'file' && !(e.offsetWidth || e.offsetHeight)) continue;
    var etiqueta = '';
    if (e.id) {
      var lab = document.querySelector('label[for="' + CSS.escape(e.id) + '"]');
      if (lab) etiqueta = (lab.textContent || '').trim();
    }
    if (!etiqueta) {
      // Workable envuelve el campo en su <label> («*First name»…).
      var wrap = e.closest('label');
      if (wrap) etiqueta = (wrap.textContent || '').trim();
    }
    if (!etiqueta) {
      var cont = e.closest('div, li, td, fieldset');
      for (var k = 0; cont && k < 4; k++) {
        var l2 = cont.querySelector ? cont.querySelector('label') : null;
        if (l2 && (l2.textContent || '').trim() && l2.htmlFor !== e.id) { etiqueta = (l2.textContent || '').trim(); break; }
        cont = cont.parentElement;
      }
    }
    if (!etiqueta) etiqueta = e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.name || e.id || '';
    // Grupo/pregunta: en los radios, el texto de la pregunta es el del
    // contenedor del <fieldset> DESCONTADAS las opciones («*Right to
    // Work» + YESNO → «Right to Work»); en el resto, la propia etiqueta.
    var grupo = '';
    if (tipo === 'radio') {
      var fs = e.closest('fieldset');
      if (fs) {
        var textoFs = fs.textContent || '';
        var nodo = fs;
        for (var u = 0; u < 3 && nodo.parentElement; u++) {
          nodo = nodo.parentElement;
          var resto = (nodo.textContent || '').split(textoFs).join('').trim();
          if (resto.length >= 3) { grupo = resto.replace(/^\\*\\s*/, ''); break; }
        }
      }
      if (!grupo) grupo = etiqueta;
    } else {
      grupo = etiqueta;
    }
    var requerido = !!e.required || e.getAttribute('aria-required') === 'true';
    if (!requerido) {
      // Workable marca con asterisco en el texto de la sección.
      var zona = e.closest('div, li, fieldset');
      if (zona && /\\*/.test(zona.textContent || '')) requerido = true;
    }
    var idPart = e.id ? '#' + CSS.escape(e.id) : (e.name ? '[name="' + e.name + '"]' : '');
    out.push({
      sel: idPart || (e.tagName.toLowerCase() + ':nth-of-type(' + (i + 1) + ')'),
      tipo: tipo, name: e.name || '', etiqueta: etiqueta, grupo: grupo, requerido: requerido,
      valor: (e.value || '').toString()
    });
  }
  return out;
})()`;

const TEXTO_JS = `(function () { return document.body ? (document.body.innerText || '') : ''; })()`;

const CLOSED_RE =
  /no longer (accepting|available)|position (has been )?(closed|filled)|this job is no longer|applications? (are )?closed/i;
const SUCCESS_RE =
  /application (has been )?(sent|submitted|received)|thank you for applying|you have (successfully )?applied|successfully applied/i;
const ZONA_DERECHO = [
  'spain',
  'españa',
  'espana',
  'madrid',
  'barcelona',
  'valencia',
  'sevilla',
  'bilbao',
  'zaragoza',
  'málaga',
  'malaga',
  'europe',
  'european union',
  'germany',
  'france',
  'italy',
  'portugal',
  'netherlands',
  'belgium',
  'ireland',
  'austria',
  'poland',
  'romania',
  'greece',
  'croatia',
  'sweden',
  'denmark',
  'finland',
  'czech',
  'hungary',
  'slovakia',
  'slovenia',
  'estonia',
  'latvia',
  'lithuania',
  'bulgaria',
  'cyprus',
  'malta',
  'luxembourg',
];

export class WorkableDriver implements BrowserDriver {
  readonly portal = 'workable';
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
      // Nada que cerrar.
    }
    this.forwarder = null;
  }

  /** URL del formulario: la de la oferta + /apply/ (verificado). */
  private urlFormulario(job: DriverJob): string {
    const u = job.applyUrl.replace(/\/+$/, '');
    return u.endsWith('/apply') ? `${u}/` : `${u}/apply/`;
  }

  private async capturar(page: PwPage, job: DriverJob, nombre: string): Promise<string> {
    const ruta = join(job.shotsDir, nombre);
    try {
      await page.screenshot({ path: ruta, fullPage: false });
    } catch {
      // La captura es evidencia, no debe tumbar el flujo.
    }
    return ruta;
  }

  private async captchaVisible(page: PwPage): Promise<boolean> {
    for (const f of page.frames()) {
      try {
        const hit = await f.evaluate<boolean>(`(function () {
          var frames = document.querySelectorAll('iframe');
          for (var i = 0; i < frames.length; i++) {
            var src = frames[i].src || '';
            if (/hcaptcha/.test(src) && /frame=challenge/.test(src)) {
              var st = window.getComputedStyle(frames[i]);
              if (st.visibility !== 'hidden' && st.display !== 'none' && frames[i].offsetWidth > 200) return true;
            }
            if (/recaptcha/.test(src) && frames[i].offsetWidth > 200 && frames[i].offsetHeight > 100) {
              var r = frames[i].getBoundingClientRect();
              if (r.bottom > 0 && r.top < window.innerHeight) return true;
            }
          }
          return false;
        })()`);
        if (hit) return true;
      } catch {
        // Siguiente marco.
      }
    }
    return false;
  }

  /** Acepta el banner de cookies si está (desbloquea la vista). */
  private async aceptarCookies(page: PwPage): Promise<void> {
    const ok = await page
      .evaluate<boolean>(`(function () {
        var bs = document.querySelectorAll('button, a');
        for (var i = 0; i < bs.length; i++) {
          if ((bs[i].textContent || '').trim().toLowerCase() === 'accept all') { bs[i].click(); return true; }
        }
        return false;
      })()`)
      .catch(() => false);
    if (ok) await page.waitForTimeout(700);
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
        detalle: `error de red abriendo Workable: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    await page.waitForTimeout(3500);
    const status = resp?.status();
    if (status !== undefined && status >= 400) {
      return { abierta: false, detalle: `HTTP ${status} al abrir el formulario de Workable` };
    }
    const texto = await page.evaluate<string>(TEXTO_JS).catch(() => '');
    if (CLOSED_RE.test(texto)) {
      return { abierta: false, detalle: 'la oferta figura cerrada en Workable' };
    }
    const tieneFormulario = await page
      .evaluate<boolean>(
        `(function () { return !!document.querySelector('#firstname, input[name="firstname"], form'); })()`,
      )
      .catch(() => false);
    if (!tieneFormulario) {
      return { abierta: false, detalle: `formulario de Workable no detectado (URL: ${page.url()})` };
    }
    return { abierta: true, detalle: 'formulario de Workable accesible (sin cuenta)' };
  }

  /** País del puesto según el encabezado de la propia página. */
  private async paisDelPuesto(page: PwPage): Promise<string> {
    const texto = await page.evaluate<string>(TEXTO_JS).catch(() => '');
    // El encabezado trae «Ciudad, Región, País» en las primeras líneas.
    const lineas = texto.split('\n').slice(0, 8).join(' ');
    return lineas.toLowerCase();
  }

  async preparar(
    job: DriverJob,
  ): Promise<{ camposRellenados: number; uploadsOk: boolean; capturas: string[] }> {
    const page = await this.pageActiva(job);
    const d = job.etiquetas;
    if (!d) {
      throw new AnomaliaEnvio('datos_ausentes', 'trabajo Workable sin datos de perfil');
    }
    const capturas: string[] = [await this.capturar(page, job, 'workable-formulario.png')];
    await this.aceptarCookies(page);
    if (await this.captchaVisible(page)) {
      throw new AnomaliaEnvio(
        'captcha_mfa',
        'captcha con desafío visible en Workable: queda para resolverlo tú',
        { trasClick: false },
      );
    }
    let campos = await page.evaluate<CampoW[]>(DESCUBRIR_JS);
    let tocados = 0;
    const paisTexto = await this.paisDelPuesto(page);
    const enZonaDerecho = ZONA_DERECHO.some((z) => paisTexto.includes(z));

    // --- Adjuntos PRIMERO --------------------------------------------------
    // Al subir el CV, Workable lo parsea en su servidor («autofill») y
    // RE-RENDERIZA el formulario segundos después: desharía cualquier
    // campo ya rellenado (visto en vivo con el radio «Right to Work»).
    // Por eso: primero las subidas, espera a que el autofill se
    // asiente, y el resto se rellena sobre el DOM final.
    let uploadsOk = false;
    for (const c of campos) {
      if (c.tipo !== 'file') continue;
      const e = `${c.etiqueta} ${c.grupo} ${c.sel}`.toLowerCase();
      const esCarta = /cover|letter|carta/.test(e);
      try {
        await page.setInputFiles(c.sel, esCarta ? job.cartaPath : job.cvPath);
        if (!esCarta) uploadsOk = true;
        tocados++;
      } catch {
        // Input con envoltorio propio; si es el CV y falla, se anota abajo.
      }
    }
    if (!uploadsOk) {
      throw new AnomaliaEnvio(
        'formulario_cambiado',
        'no se pudo subir el CV al formulario de Workable (input de fichero no operable)',
      );
    }
    await page.waitForTimeout(4500);
    campos = await page.evaluate<CampoW[]>(DESCUBRIR_JS);

    // --- Campos estándar por id/nombre/etiqueta -------------------------
    const rellenados = new Set<string>();
    for (const c of campos) {
      const clave = `${c.sel}`;
      const e = `${c.etiqueta} ${c.grupo}`.toLowerCase();
      let valor: string | null = null;
      if (/#firstname|first.?name|nombre(?!.*empresa)/.test(`${c.sel} ${e}`)) valor = d.nombre;
      else if (/#lastname|last.?name|apellidos?/.test(`${c.sel} ${e}`)) valor = d.apellidos;
      else if (/e-?mail|correo/.test(e) || c.tipo === 'email') valor = d.email;
      else if (/phone|teléfono|telefono|mobile/.test(e)) valor = d.telefono || null;
      else if (/linkedin/.test(e)) valor = d.linkedin || null;
      else if (/salary|salario|sueldo|compensation|pay expectation/.test(e)) {
        valor = d.salarioEsperado;
        if (!valor && c.requerido) {
          throw new AnomaliaEnvio(
            'datos_ausentes',
            `Workable pide una cifra obligatoria que no invento: «${c.grupo || c.etiqueta}» — dime tu sueldo bruto esperado para este puesto y lo dejo guardado en tu perfil`,
          );
        }
      }
      if (valor) {
        if (c.tipo === 'text' || c.tipo === 'email' || c.tipo === 'tel' || c.tipo === 'textarea' || c.tipo === 'number') {
          await page.fill(c.sel, valor).catch(() => undefined);
          tocados++;
          rellenados.add(clave);
        }
      }
    }

    // --- Radios (preguntas Sí/No y similares) ----------------------------
    const gruposRadio = new Map<string, CampoW[]>();
    for (const c of campos) {
      if (c.tipo !== 'radio') continue;
      const claveGrupo = c.name || c.grupo;
      const lista = gruposRadio.get(claveGrupo) ?? [];
      lista.push(c);
      gruposRadio.set(claveGrupo, lista);
    }
    for (const [, opciones] of gruposRadio) {
      const g = (opciones[0].grupo || '').toLowerCase();
      const esDerecho = /right to work|derecho a trabajar|work permit|autorizaci[oó]n para trabajar|eligible to work/.test(g);
      if (esDerecho) {
        const objetivo = enZonaDerecho ? /^(yes|sí|si|true)$/i : /^(no|false)$/i;
        const elegida = opciones.find((o) => objetivo.test(o.etiqueta.trim()));
        if (elegida) {
          // Los radios de Workable son decorativos: en vivo SOLO el
          // clic JS directo sobre el <input> marca la opción (los
          // clics de ratón de Playwright sobre la etiqueta o el «pill»
          // ni siquiera superan la accionabilidad, y sin marcar el
          // formulario rechaza el envío: «Please select one of these
          // options»). Se verifica el checked tras una espera breve.
          // Workable regenera los ids de los radios en CADA render de
          // React y el checked vive en el nodo nuevo tras el clic: la
          // identidad estable es el NAME del grupo (+ la etiqueta o el
          // value de la opción). Localizar, clicar y verificar se hace
          // siempre por name contra el DOM vivo, nunca por id.
          const nombreGrupo = elegida.name.replace(/["\\]/g, '');
          const patronTxt = enZonaDerecho ? '/^(yes|sí|si|true)$/i' : '/^(no|false)$/i';
          const marcarEnPagina = `(function () {
            var inputs = document.querySelectorAll('input[type="radio"][name="${nombreGrupo}"]');
            var patron = ${patronTxt};
            for (var i = 0; i < inputs.length; i++) {
              var el = inputs[i];
              var lab = el.closest('label');
              var txt = lab ? (lab.textContent || '').trim() : '';
              if (patron.test(txt) || patron.test(el.value || '')) { el.click(); return txt || el.value; }
            }
            return null;
          })()`;
          const leerMarcada = `(function () {
            var c = document.querySelector('input[type="radio"][name="${nombreGrupo}"]:checked');
            if (!c) return null;
            var lab = c.closest('label');
            return lab ? (lab.textContent || '').trim() : (c.value || '');
          })()`;
          let marcado = false;
          for (let intento = 0; intento < 3 && !marcado; intento++) {
            await page.evaluate<string | null>(marcarEnPagina).catch(() => null);
            await page.waitForTimeout(700);
            const actual = await page.evaluate<string | null>(leerMarcada).catch(() => null);
            marcado = actual !== null && objetivo.test(actual.trim());
          }
          if (!marcado) {
            throw new AnomaliaEnvio(
              'formulario_cambiado',
              `no se pudo marcar la opción «${elegida.etiqueta}» en la pregunta «${opciones[0].grupo}» de Workable`,
            );
          }
          tocados++;
          continue;
        }
      }
      // Grupo sin respuesta determinada: si es obligatorio, parada.
      const algunoRequerido = opciones.some((o) => o.requerido);
      if (algunoRequerido) {
        throw new AnomaliaEnvio(
          'datos_ausentes',
          `pregunta obligatoria de Workable sin respuesta determinada en tu perfil: «${opciones[0].grupo}» — dímela y la aplico`,
        );
      }
    }

    // --- Verificación de obligatorios de texto ---------------------------
    const tras = await page.evaluate<CampoW[]>(DESCUBRIR_JS);
    const pendiente = tras.find(
      (c) =>
        c.requerido &&
        (c.tipo === 'text' || c.tipo === 'email' || c.tipo === 'textarea') &&
        (!c.valor || c.valor.trim() === '') &&
        !/cover|letter|carta/.test(`${c.etiqueta} ${c.grupo}`.toLowerCase()),
    );
    if (pendiente) {
      throw new AnomaliaEnvio(
        'datos_ausentes',
        `campo obligatorio de Workable sin respuesta en tu perfil: «${pendiente.grupo || pendiente.etiqueta}»`,
      );
    }
    capturas.push(await this.capturar(page, job, 'workable-relleno.png'));
    return { camposRellenados: tocados, uploadsOk, capturas };
  }

  /** Marco del widget de Cloudflare Turnstile, si lo hay. */
  private frameTurnstile(page: PwPage): PwFrame | null {
    return (
      page.frames().find((f) => /challenges\.cloudflare\.com/.test(f.url())) ?? null
    );
  }

  /**
   * Turnstile («Verify you are human»): es UN clic de atestación que
   * Jon ha autorizado expresamente a dar (2026-10-21). Se pulsa la
   * casilla y se espera el token; si Cloudflare escala a un desafío
   * visual (el widget se expande), eso NO se resuelve: 'desafio'.
   */
  private async completarTurnstile(
    page: PwPage,
  ): Promise<'ok' | 'ausente' | 'desafio'> {
    const frame = this.frameTurnstile(page);
    if (!frame) return 'ausente';
    const tokenListo = async (): Promise<boolean> =>
      page
        .evaluate<boolean>(
          `(function () {
            var t = document.querySelector('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]');
            return !!t && (t.value || '').length > 20;
          })()`,
        )
        .catch(() => false);
    if (await tokenListo()) return 'ok';
    // Clic en la casilla del widget (esquina izquierda del marco).
    await frame.click('body', { position: { x: 24, y: 24 }, timeout: 8000 }).catch(() => undefined);
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(1000);
      if (await tokenListo()) return 'ok';
      // ¿Desafío visual? El marco crece mucho en altura.
      const alto = await frame
        .evaluate<number>(
          `(function () { return document.documentElement ? document.documentElement.scrollHeight : 0; })()`,
        )
        .catch(() => 0);
      if (alto > 260) return 'desafio';
    }
    return (await tokenListo()) ? 'ok' : 'desafio';
  }

  async enviarYConfirmar(job: DriverJob): Promise<ResultadoDriver> {
    const page = await this.pageActiva(job);
    const capturas: string[] = [];
    // Primero la atestación de Turnstile si el formulario la trae.
    const turnstile = await this.completarTurnstile(page);
    if (turnstile === 'desafio') {
      capturas.push(await this.capturar(page, job, 'workable-turnstile.png'));
      throw new AnomaliaEnvio(
        'captcha_mfa',
        'Cloudflare Turnstile escaló a desafío visual en Workable: ese paso queda para que lo completes tú (la candidatura está rellenada, sin enviar)',
        { trasClick: false },
      );
    }
    const pulsado = await page
      .evaluate<boolean>(`(function () {
        var bs = document.querySelectorAll('button, input[type="submit"]');
        for (var i = 0; i < bs.length; i++) {
          var t = ((bs[i].textContent || bs[i].value || '')).trim().toLowerCase();
          if (t === 'submit application' || t === 'submit' || t === 'enviar solicitud' || t === 'apply') {
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
        `no se encontró el botón «Submit application» en Workable (URL: ${page.url()})`,
      );
    }
    // Sondeo: éxito, o el muro de verificación humana (Turnstile de
    // Cloudflare aparece junto al botón y deja el envío en
    // «Submitting…» sin completar: NO es un envío dudoso, es una
    // atestación que debe hacer Jon).
    for (let espera = 0; espera < 8; espera++) {
      await page.waitForTimeout(3000);
      const textoSon = await page.evaluate<string>(TEXTO_JS).catch(() => '');
      if (SUCCESS_RE.test(textoSon) || /apply\/confirmation|thank/i.test(page.url())) {
        capturas.push(await this.capturar(page, job, 'workable-tras-envio.png'));
        return {
          confirmado: true,
          confirmacion: {
            mensaje: 'Workable confirmó la recepción de la candidatura.',
            urlTrasEnvio: page.url(),
            referencia: null,
            capturas,
          },
          capturas,
          evidencia: { portal: 'workable' },
        };
      }
      if (await this.captchaVisible(page)) {
        capturas.push(await this.capturar(page, job, 'workable-tras-envio.png'));
        throw new AnomaliaEnvio(
          'captcha_mfa',
          'Workable exige verificar que eres humano (Cloudflare Turnstile) para completar el envío: la candidatura quedó rellenada sin enviar',
          { trasClick: true },
        );
      }
    }
    capturas.push(await this.capturar(page, job, 'workable-tras-envio.png'));
    return { confirmado: false, capturas, evidencia: { portal: 'workable' } };
  }
}
