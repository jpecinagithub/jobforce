/** Réplica instrumentada del preparar() del WorkableDriver. */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const { cargarPlaywright, resolveChromiumExe } = await import('/app/apps/backend/dist/sender/driver.js');

// Localiza un CV pdf real generado por JOBFORCE en el workspace.
function buscarPdf(dir, patron, limite) {
  let out = [];
  let items = [];
  try { items = readdirSync(dir); } catch { return out; }
  for (const it of items) {
    const p = join(dir, it);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) out = out.concat(buscarPdf(p, patron, limite));
    else if (patron.test(it)) out.push(p);
    if (out.length >= limite) return out;
  }
  return out;
}
const pdfs = buscarPdf('/home/app/workspace/jobforce/documents', /cv.*.pdf$/i, 3);
console.log('PDFs:', pdfs);
const cvPath = pdfs[0];

const DESCUBRIR = await import('node:fs').then((fs) => {
  const src = fs.readFileSync('/app/apps/backend/dist/sender/workable-driver.js', 'utf8');
  const m = src.match(/const DESCUBRIR_JS = (`[\s\S]*?`);/);
  // eslint-disable-next-line no-eval
  return eval(m[1]);
});

const chromium = cargarPlaywright();
const browser = await chromium.launch({
  executablePath: resolveChromiumExe(),
  headless: true,
  args: ['--ignore-certificate-errors', '--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
});
const page = await browser.newPage({
  viewport: { width: 1360, height: 1100 },
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  locale: 'en-US',
});
await page.goto(process.argv[2], { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3500);

// Cookies
await page.evaluate(`(function () { var bs = document.querySelectorAll('button, a'); for (var i = 0; i < bs.length; i++) { if ((bs[i].textContent || '').trim().toLowerCase() === 'accept all') { bs[i].click(); return true; } } return false; })()`).catch(() => false);
await page.waitForTimeout(700);

let campos = await page.evaluate(DESCUBRIR);
console.log('descubrimiento inicial:', campos.map((c) => `${c.tipo}:${c.sel}:${c.etiqueta}`).join(' | '));

// Subidas primero
for (const c of campos) {
  if (c.tipo !== 'file') continue;
  const esCarta = /cover|letter|carta/i.test(`${c.etiqueta} ${c.grupo} ${c.sel}`);
  if (!esCarta) {
    await page.setInputFiles(c.sel, cvPath);
    console.log('CV subido vía', c.sel);
  }
}
await page.waitForTimeout(4500);
campos = await page.evaluate(DESCUBRIR);
console.log('tras autofill:', campos.map((c) => `${c.tipo}:${c.sel}:${c.etiqueta}`).join(' | '));

// Rellenos estándar
for (const c of campos) {
  const e = `${c.etiqueta} ${c.grupo}`.toLowerCase();
  let valor = null;
  if (/#firstname|first.?name/.test(`${c.sel} ${e}`)) valor = 'Jon';
  else if (/#lastname|last.?name/.test(`${c.sel} ${e}`)) valor = 'Peciña Iturbe';
  else if (/e-?mail/.test(e) || c.tipo === 'email') valor = 'jpecina@gmail.com';
  else if (/salary/.test(e)) valor = '80000 EUR';
  if (valor && ['text', 'email', 'tel', 'textarea', 'number'].includes(c.tipo)) {
    await page.fill(c.sel, valor).catch((err) => console.log('fill falló', c.sel, String(err).split('\n')[0]));
    console.log('relleno', c.sel, '=', valor);
  }
}

// Radios
campos = await page.evaluate(DESCUBRIR);
const radios = campos.filter((c) => c.tipo === 'radio');
console.log('radios:', JSON.stringify(radios));
const elegida = radios.find((o) => /^(no|false)$/i.test(o.etiqueta.trim()));
console.log('elegida:', JSON.stringify(elegida));
if (elegida) {
  const existe = await page.evaluate(`(function () { return !!document.querySelector('${elegida.sel}'); })()`);
  console.log('querySelector(elegida.sel) existe:', existe);
  const clic = await page.evaluate(`(function () { var el = document.querySelector('${elegida.sel}'); if (!el) return 'no-el'; el.click(); return 'click-ok checked-inmediato=' + el.checked; })()`);
  console.log('clic:', clic);
  await page.waitForTimeout(600);
  console.log('checked +600ms:', await page.evaluate(`(function () { var el = document.querySelector('${elegida.sel}'); return el ? el.checked : 'sin-el'; })()`));
  await page.waitForTimeout(2000);
  console.log('checked +2600ms:', await page.evaluate(`(function () { var r = document.querySelector('input[type="radio"]:checked'); return r ? (r.closest('label') || {}).textContent : 'ninguno'; })()`));
}
await page.screenshot({ path: '/tmp/flow-final.png' });
await browser.close();
