/** Inspección del flujo Workday: job → Apply → puerta de cuenta. */
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
const dump = async (tag) => {
  const t = await page.evaluate(`(document.body.innerText || '').slice(0, 1500)`).catch(() => '');
  console.log(`===== ${tag} :: ${page.url().slice(0, 110)}`);
  console.log(t);
};
await page.goto(process.argv[2], { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(5000);
await page.screenshot({ path: '/tmp/wd-1-job.png' });
await dump('JOB');
// Botón Apply
const clicked = await page.evaluate(`(function () {
  var els = document.querySelectorAll('a, button');
  for (var i = 0; i < els.length; i++) {
    var t = (els[i].textContent || '').trim().toLowerCase();
    if (t === 'apply' || t === 'apply now' || t === 'postuler' || t === 'solicitar') {
      els[i].click(); return els[i].textContent.trim();
    }
  }
  return null;
})()`);
console.log('CLICK APPLY:', clicked);
await page.waitForTimeout(5000);
await page.screenshot({ path: '/tmp/wd-2-apply.png' });
await dump('TRAS APPLY');
// Paso: Autofill with Resume
const auto = await page.evaluate(`(function () {
  var els = document.querySelectorAll('a, button');
  for (var i = 0; i < els.length; i++) {
    if ((els[i].textContent || '').trim().toLowerCase() === 'autofill with resume') { els[i].click(); return true; }
  }
  return false;
})()`);
console.log('CLICK AUTOFILL:', auto);
await page.waitForTimeout(5000);
await page.screenshot({ path: '/tmp/wd-3-autofill.png' });
await dump('TRAS AUTOFILL');
const inputs = await page.evaluate(`(function () {
  var out = [];
  var els = document.querySelectorAll('input');
  for (var i = 0; i < els.length; i++) out.push(els[i].type + '#' + (els[i].id || '') + '@' + (els[i].getAttribute('data-automation-id') || ''));
  return out.join(' | ');
})()`);
console.log('INPUTS:', inputs.slice(0, 500));
// Opciones de aplicación (Apply Manually / Create account / Sign in…)
const opciones = await page.evaluate(`(function () {
  var out = [];
  var els = document.querySelectorAll('a, button');
  for (var i = 0; i < els.length; i++) {
    var t = (els[i].textContent || '').trim();
    if (t && t.length < 60) out.push(t);
  }
  return out.join(' | ');
})()`);
console.log('BOTONES:', opciones.slice(0, 600));
await browser.close();
