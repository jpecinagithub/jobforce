/** Inspección de solo lectura del formulario de aplicación de Workable. */
const { cargarPlaywright, resolveChromiumExe } = await import('/app/apps/backend/dist/sender/driver.js');
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
const url = process.argv[2].replace(/\/$/, "") + "/apply/";
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4500);
console.log('URL', page.url());
console.log('FRAMES', page.frames().map((f) => f.url().slice(0, 70)).join(' || '));
for (const f of page.frames()) {
  const info = await f.evaluate(`(function () {
    var campos = [];
    var nodes = document.querySelectorAll('input, select, textarea');
    for (var i = 0; i < nodes.length; i++) {
      var e = nodes[i];
      var tipo = (e.getAttribute('type') || e.tagName).toLowerCase();
      if (tipo === 'hidden') continue;
      var etiqueta = '';
      if (e.id) { var lab = document.querySelector('label[for="' + CSS.escape(e.id) + '"]'); if (lab) etiqueta = (lab.textContent || '').trim().slice(0, 60); }
      if (!etiqueta) etiqueta = e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.name || e.id || '';
      campos.push({ tipo: tipo, id: e.id, name: e.name, etiqueta: etiqueta, req: !!e.required || e.getAttribute('aria-required') === 'true', visible: !!(e.offsetWidth || e.offsetHeight) });
    }
    var btns = [];
    var bs = document.querySelectorAll('button, input[type="submit"], a[role="button"]');
    for (var j = 0; j < bs.length; j++) { var t = ((bs[j].textContent || bs[j].value || '')).trim().slice(0, 40); if (t && (bs[j].offsetWidth || bs[j].offsetHeight)) btns.push(t); }
    return { campos: campos.slice(0, 40), btns: btns.slice(0, 10) };
  })()`).catch((e) => ({ error: String(e).slice(0, 120) }));
  console.log('FRAME', f.url().slice(0, 60), JSON.stringify(info).slice(0, 2400));
}
// Segundo paso: aceptar cookies y pulsar «Apply for this job».
try { await page.click('text=Accept all', { timeout: 4000 }); } catch {}
await page.waitForTimeout(800);
try { await page.click('text=Apply for this job', { timeout: 8000 }); } catch (e) { console.log('CLICK APPLY FALLO', String(e).split('\n')[0]); }
await page.waitForTimeout(4500);
console.log('URL2', page.url());
console.log('FRAMES2', page.frames().map((f) => f.url().slice(0, 70)).join(' || '));
for (const f of page.frames()) {
  const info = await f.evaluate(`(function () {
    var campos = [];
    var nodes = document.querySelectorAll('input, select, textarea');
    for (var i = 0; i < nodes.length; i++) {
      var e = nodes[i];
      var tipo = (e.getAttribute('type') || e.tagName).toLowerCase();
      if (tipo === 'hidden') continue;
      var etiqueta = '';
      if (e.id) { var lab = document.querySelector('label[for="' + CSS.escape(e.id) + '"]'); if (lab) etiqueta = (lab.textContent || '').trim().slice(0, 70); }
      if (!etiqueta) {
        var cont = e.closest('div, li, fieldset');
        for (var k = 0; cont && k < 4; k++) { var l2 = cont.querySelector ? cont.querySelector('label') : null; if (l2 && (l2.textContent || '').trim()) { etiqueta = (l2.textContent || '').trim().slice(0, 70); break; } cont = cont.parentElement; }
      }
      if (!etiqueta) etiqueta = e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.name || e.id || '';
      var opciones = [];
      if (e.tagName === 'SELECT') for (var j = 0; j < e.options.length; j++) opciones.push((e.options[j].textContent || '').trim());
      campos.push({ tipo: tipo, id: e.id, name: e.name, etiqueta: etiqueta, req: !!e.required || e.getAttribute('aria-required') === 'true', visible: !!(e.offsetWidth || e.offsetHeight), opciones: opciones.slice(0, 6) });
    }
    var btns = [];
    var bs = document.querySelectorAll('button, input[type="submit"], a[role="button"]');
    for (var j = 0; j < bs.length; j++) { var t = ((bs[j].textContent || bs[j].value || '')).trim().slice(0, 40); if (t && (bs[j].offsetWidth || bs[j].offsetHeight)) btns.push(t); }
    var captcha = !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, .h-captcha');
    return { campos: campos.slice(0, 44), btns: btns.slice(0, 10), captcha: captcha };
  })()`).catch((e) => ({ error: String(e).slice(0, 120) }));
  console.log('FRAME2', f.url().slice(0, 60), JSON.stringify(info).slice(0, 3400));
}
await page.screenshot({ path: '/tmp/workable2.png', fullPage: false });
await browser.close();
