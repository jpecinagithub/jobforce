/** Diagnóstico Turnstile: reproduce el estado «Submitting…» y prueba el clic. */
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
await page.goto(process.argv[2], { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4000);
// Relleno mínimo obligatorio
await page.fill('#firstname', 'Jon');
await page.fill('#lastname', 'Peciña Iturbe');
await page.fill('#email', 'jpecina@gmail.com');
const cv = '/home/app/workspace/jobforce/documents/3873baf8-f75f-4977-b730-9d0e29a068c7/cv-v1.pdf';
const fileInput = await page.$('input[type="file"]');
if (fileInput) await fileInput.setInputFiles(cv);
await page.waitForTimeout(4500);
await page.fill('#CA_3451', '80000 EUR').catch(() => {});
// Radio NO por name (como el driver)
await page.evaluate(`(function () {
  var inputs = document.querySelectorAll('input[type="radio"][name="CA_3447"]');
  for (var i = 0; i < inputs.length; i++) {
    var lab = inputs[i].closest('label');
    if (lab && (lab.textContent || '').trim() === 'NO') { inputs[i].click(); return; }
  }
})()`);
await page.waitForTimeout(800);
console.log('frames ANTES de submit:', page.frames().map((f) => f.url().slice(0, 60)).join(' || '));
// Submit
await page.evaluate(`(function () {
  var bs = document.querySelectorAll('button, input[type="submit"]');
  for (var i = 0; i < bs.length; i++) {
    var t = ((bs[i].textContent || bs[i].value || '')).trim().toLowerCase();
    if (t === 'submit application') { bs[i].click(); return true; }
  }
  return false;
})()`);
await page.waitForTimeout(4000);
console.log('frames TRAS submit:', page.frames().map((f) => f.url().slice(0, 80)).join(' || '));
const frames = page.frames();
const ts = frames.find((f) => /challenges\.cloudflare\.com/.test(f.url()));
console.log('frame Turnstile encontrado:', !!ts);
const token = async () =>
  page.evaluate(`(function () {
    var t = document.querySelector('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]');
    return t ? (t.value || '').length : -1;
  })()`);
console.log('token len inicial:', await token());
if (ts) {
  await ts.click('body', { position: { x: 24, y: 28 }, timeout: 8000 })
    .then(() => console.log('click en frame OK'))
    .catch((e) => console.log('click en frame FALLO:', String(e).split('\n')[0]));
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(1500);
    const len = await token();
    const estado = await ts.evaluate(`(function () {
      var c = document.querySelector('input[type="checkbox"]');
      return c ? 'checkbox checked=' + c.checked : 'sin checkbox en el frame';
    })()`).catch((e) => 'eval err');
    console.log(`t+${(i + 1) * 1.5}s token len=${len} ${estado}`);
    if (len > 20) break;
  }
}
await page.screenshot({ path: '/tmp/turnstile-probe.png' });
await browser.close();
