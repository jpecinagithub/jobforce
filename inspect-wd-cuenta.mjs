/** Inspección del paso 1 de Workday: DOM del formulario de cuenta. */
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
await page.waitForTimeout(5000);
const clickTxt = (t) =>
  page.evaluate(`(function (t) {
    var els = document.querySelectorAll('a, button');
    for (var i = 0; i < els.length; i++) {
      if ((els[i].textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase() === t) { els[i].click(); return true; }
    }
    return false;
  })('${t}')`);
console.log('apply:', await clickTxt('apply'));
await page.waitForTimeout(3000);
console.log('autofill:', await clickTxt('autofill with resume'));
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(2500);
  const info = await page.evaluate(`(function () {
    var inputs = [];
    var els = document.querySelectorAll('input');
    for (var j = 0; j < els.length; j++) {
      var e = els[j];
      inputs.push([e.type, 'id=' + (e.id || ''), 'name=' + (e.name || ''), 'aid=' + (e.getAttribute('data-automation-id') || ''), 'ph=' + (e.getAttribute('placeholder') || ''), 'vis=' + (!!(e.offsetWidth || e.offsetHeight))].join(' '));
    }
    return {
      frames: 'n/a',
      inputs: inputs,
      titulos: (document.body.innerText || '').slice(0, 300),
    };
  })()`);
  console.log(`--- t+${(i + 1) * 2.5}s inputs=${info.inputs.length}`);
  info.inputs.forEach((x) => console.log('  ', x));
  if (info.inputs.some((x) => x.includes('password'))) {
    console.log('TEXTO:', info.titulos.replace(/\n/g, ' | '));
    break;
  }
}
console.log('FRAMES:', page.frames().map((f) => f.url().slice(0, 70)).join(' || '));
await page.screenshot({ path: '/tmp/wd-cuenta.png' });
await browser.close();
