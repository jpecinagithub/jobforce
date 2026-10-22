/**
 * Resolución del canal real de aplicación (global, 2026-10-22).
 *
 * Problema: muchas ofertas se ENCUENTRAN en bolsas (The Impact Job,
 * ReliefWeb, LinkedIn…) pero se APLICA en el portal del empleador
 * (Ashby, Greenhouse, Workday…). Si la candidatura se clasifica por
 * la URL de la bolsa, su portal queda «otro»: sin driver y bloqueado
 * por la política aunque el destino real sí sea un portal soportado
 * (caso real: The Impact Job → Ashby en Possible Finance).
 *
 * Este módulo sigue la bolsa hasta el destino — cadena de
 * redirecciones, enlaces a portales conocidos en el HTML y la ruta
 * «apply» propia de la bolsa — y devuelve el portal + URL reales.
 * `portalDesdeUrl` refleja los patrones de `prepare.ts` (PORTALES);
 * vive aquí para no crear un ciclo de imports con el ejecutor.
 */

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const PATRONES_PORTAL: Array<{ patron: string; portal: string }> = [
  { patron: 'ashbyhq.com', portal: 'ashby' },
  { patron: 'myworkdayjobs', portal: 'workday' },
  { patron: 'workday', portal: 'workday' },
  { patron: 'icims.com', portal: 'icims' },
  { patron: 'workable.com', portal: 'workable' },
  { patron: 'greenhouse', portal: 'greenhouse' },
  { patron: 'lever.co', portal: 'lever' },
  { patron: 'personio', portal: 'personio' },
  { patron: 'smartrecruiters', portal: 'smartrecruiters' },
  { patron: 'breezy.hr', portal: 'breezy' },
  { patron: 'recruitee.com', portal: 'recruitee' },
];

/** Portal conocido de una URL, o null si es una bolsa/genérica. */
export function portalDesdeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const p of PATRONES_PORTAL) {
    if (host.includes(p.patron)) return p.portal;
  }
  return null;
}

export type ResolucionCanal =
  | { portal: string; url: string; via: string }
  | { email: string; via: string };

interface RespuestaManual {
  status: number;
  location: string | null;
  html: string | null;
}

async function fetchManual(url: string, timeoutMs = 15_000): Promise<RespuestaManual | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    });
    const location = res.headers.get('location');
    const tipo = res.headers.get('content-type') ?? '';
    const html =
      res.status === 200 && tipo.includes('html') ? await res.text().catch(() => null) : null;
    return { status: res.status, location, html };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface Enlace {
  href: string;
  texto: string;
}

function extraerEnlaces(html: string, base: string): Enlace[] {
  const out: Enlace[] = [];
  const re = /<a\s[^>]*href\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const crudo = m[1].trim();
    if (!crudo || crudo.startsWith('#') || crudo.startsWith('javascript:')) continue;
    let href = crudo;
    if (!crudo.startsWith('mailto:')) {
      try {
        href = new URL(crudo, base).href;
      } catch {
        continue;
      }
    }
    const texto = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    out.push({ href, texto });
  }
  return out;
}

/**
 * Sigue la URL de la bolsa hasta el canal real. Devuelve null si no
 * hay evidencia suficiente (la puerta de política juzgará lo que haya).
 */
export async function resolverCanalReal(urlBolsa: string): Promise<ResolucionCanal | null> {
  if (!urlBolsa) return null;
  const directo = portalDesdeUrl(urlBolsa);
  if (directo) return { portal: directo, url: urlBolsa, via: 'url_directa' };
  // Segmento propio de la oferta en la bolsa (id numérico o uuid del
  // path): discrimina su ruta «apply» de las de ofertas relacionadas.
  const segmentos = (() => {
    try {
      return new URL(urlBolsa).pathname.split('/').filter(Boolean);
    } catch {
      return [];
    }
  })();
  const segmentoPropio = segmentos[segmentos.length - 1] ?? '';

  let actual = urlBolsa;
  for (let salto = 0; salto < 5; salto++) {
    const r = await fetchManual(actual);
    if (!r) return null;
    if (r.location) {
      let destino: string;
      try {
        destino = new URL(r.location, actual).href;
      } catch {
        return null;
      }
      const p = portalDesdeUrl(destino);
      if (p) return { portal: p, url: destino, via: 'redireccion' };
      actual = destino;
      continue;
    }
    if (!r.html) return null;
    const enlaces = extraerEnlaces(r.html, actual);
    // 1) Enlace directo a un portal conocido.
    for (const e of enlaces) {
      const p = portalDesdeUrl(e.href);
      if (p) return { portal: p, url: e.href, via: 'enlace_en_pagina' };
    }
    // 2) Canal por correo.
    const mailto = enlaces.find((e) => e.href.startsWith('mailto:'));
    if (mailto) {
      const email = mailto.href.slice('mailto:'.length).split('?')[0].trim();
      if (email) return { email, via: 'mailto_en_pagina' };
    }
    // 3) Ruta «apply» de la propia bolsa (la de ESTA oferta primero).
    const candidatas = enlaces.filter((e) => {
      let path = '';
      try {
        path = new URL(e.href).pathname;
      } catch {
        path = e.href;
      }
      return /\/apply\b/i.test(path) || /^apply( now)?$/i.test(e.texto);
    });
    const ruta =
      candidatas.find((e) => segmentoPropio && e.href.includes(segmentoPropio)) ?? candidatas[0];
    if (!ruta) return null;
    const r2 = await fetchManual(ruta.href);
    if (!r2) return null;
    if (r2.location) {
      try {
        const destino = new URL(r2.location, ruta.href).href;
        const p = portalDesdeUrl(destino);
        if (p) return { portal: p, url: destino, via: 'ruta_apply_bolsa' };
        actual = destino;
        continue;
      } catch {
        return null;
      }
    }
    if (r2.html) {
      for (const e of extraerEnlaces(r2.html, ruta.href)) {
        const p = portalDesdeUrl(e.href);
        if (p) return { portal: p, url: e.href, via: 'ruta_apply_bolsa' };
      }
    }
    return null;
  }
  return null;
}
