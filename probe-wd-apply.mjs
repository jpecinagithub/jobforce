/** Diagnóstico: ¿por qué verificarApertura no ve el botón Apply? */
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
for (const espera of [4000, 4000, 6000]) {
  await page.waitForTimeout(espera);
  const info = await page.evaluate(`(function () {
    function norm(s) { return (s || '').replace(/\\s+/g, ' ').trim().toLowerCase(); }
    var out = [];
    var els = document.querySelectorAll('a, button, [role="button"]');
    for (var i = 0; i < els.length; i++) {
      var t = norm(els[i].textContent);
      if (t && t.length < 40) out.push(t + ' [vis=' + (!!(els[i].offsetWidth || els[i].offsetHeight)) + ']');
    }
    return { url: location.href, botones: out.slice(0, 25), ready: document.readyState };
  })()`);
  console.log(`t+${espera}ms`, JSON.stringify(info).slice(0, 700));
  if (info.botones.some((b) => b.startsWith('apply'))) break;
}
await page.screenshot({ path: '/tmp/wd-apply-probe.png' });
await browser.close();
