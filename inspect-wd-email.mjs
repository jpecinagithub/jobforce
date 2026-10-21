/** Qué pasa tras pulsar «Sign in with email» en el asistente (en vivo). */
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
const clickTxt = (t) =>
  page.evaluate(`(function (t) {
    function norm(s) { return (s || '').replace(/\\s+/g, ' ').trim().toLowerCase(); }
    var els = document.querySelectorAll('a, button');
    for (var i = 0; i < els.length; i++) {
      if ((els[i].offsetWidth || els[i].offsetHeight) && norm(els[i].textContent) === t) { els[i].click(); return true; }
    }
    return false;
  })('${t}')`);
const estado = () =>
  page.evaluate(`(function () {
    var pass = 0;
    var ins = document.querySelectorAll('input');
    for (var i = 0; i < ins.length; i++) if (ins[i].type === 'password' && (ins[i].offsetWidth || ins[i].offsetHeight)) pass++;
    var t = document.body.innerText || '';
    return 'pass=' + pass + ' url=' + location.pathname.slice(-28) + ' chooser=' + /sign in with email/i.test(t);
  })()`);
await page.goto(process.argv[2], { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(5000);
console.log('apply:', await clickTxt('apply'));
await page.waitForTimeout(3000);
console.log('autofill:', await clickTxt('autofill with resume'));
// Esperar al selector
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(2500);
  const e = await estado();
  console.log('espera', i, e);
  if (e.includes('chooser=true')) break;
}
console.log('— clic JS en sign in with email:', await clickTxt('sign in with email'));
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(2000);
  console.log('postJS', i, await estado());
}
// Si sigue el selector, clic NATIVO con getByRole
if ((await estado()).includes('pass=0')) {
  try {
    await page.getByRole('button', { name: /sign in with email/i }).first().click({ timeout: 8000 });
    console.log('clic nativo hecho');
  } catch (e) {
    console.log('clic nativo FALLÓ:', String(e).slice(0, 160));
  }
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(2000);
    console.log('postNativo', i, await estado());
  }
}
await page.screenshot({ path: '/tmp/wd-email.png' });
await browser.close();
