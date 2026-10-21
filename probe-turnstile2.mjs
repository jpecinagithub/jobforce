/** Diagnóstico 2: clic de ratón sobre el elemento iframe de Turnstile. */
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
await page.fill('#firstname', 'Jon');
await page.fill('#lastname', 'Peciña Iturbe');
await page.fill('#email', 'jpecina@gmail.com');
const cv = '/home/app/workspace/jobforce/documents/3873baf8-f75f-4977-b730-9d0e29a068c7/cv-v1.pdf';
const fileInput = await page.$('input[type="file"]');
if (fileInput) await fileInput.setInputFiles(cv);
await page.waitForTimeout(4500);
await page.fill('#CA_3451', '80000 EUR').catch(() => {});
await page.evaluate(`(function () {
  var inputs = document.querySelectorAll('input[type="radio"][name="CA_3447"]');
  for (var i = 0; i < inputs.length; i++) {
    var lab = inputs[i].closest('label');
    if (lab && (lab.textContent || '').trim() === 'NO') { inputs[i].click(); return; }
  }
})()`);
await page.waitForTimeout(800);
await page.evaluate(`(function () {
  var bs = document.querySelectorAll('button, input[type="submit"]');
  for (var i = 0; i < bs.length; i++) {
    var t = ((bs[i].textContent || bs[i].value || '')).trim().toLowerCase();
    if (t === 'submit application') { bs[i].click(); return true; }
  }
  return false;
})()`);
await page.waitForTimeout(4000);
const iframeEl = await page.$('iframe[src*="challenges.cloudflare.com"]');
console.log('iframe en el DOM principal:', !!iframeEl);
if (iframeEl) {
  const box = await iframeEl.boundingBox();
  console.log('boundingBox:', JSON.stringify(box));
  if (box) {
    await page.mouse.click(box.x + 24, box.y + box.height / 2);
    console.log('mouse.click lanzado sobre la casilla');
  }
}
for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(2000);
  const estado = await page.evaluate(`(function () {
    var btns = document.querySelectorAll('button');
    var bt = '';
    for (var i = 0; i < btns.length; i++) { var t = (btns[i].textContent || '').trim(); if (/submit/i.test(t)) bt = t; }
    return JSON.stringify({ url: location.href, boton: bt, texto: (document.body.innerText || '').slice(0, 200) });
  })()`);
  console.log(`t+${(i + 1) * 2}s`, estado);
  if (/thank|success|received/i.test(estado)) break;
}
await page.screenshot({ path: '/tmp/turnstile-probe2.png' });
await browser.close();
