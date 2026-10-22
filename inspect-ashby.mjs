/** Inspección del formulario de Ashby (Possible Finance): DOM real. */
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
const DUMP = `(function () {
  function norm(s) { return (s || '').replace(/\\s+/g, ' ').trim(); }
  var out = [];
  var els = document.querySelectorAll('input, select, textarea');
  for (var i = 0; i < els.length; i++) {
    var e = els[i];
    var lab = '';
    if (e.id) { var l = document.querySelector('label[for="' + e.id + '"]'); if (l) lab = norm(l.textContent); }
    if (!lab) lab = e.getAttribute('aria-label') || e.getAttribute('placeholder') || '';
    out.push(e.tagName.toLowerCase() + '|' + (e.type || '') + '|name=' + (e.name || '') + '|label=' + lab.slice(0, 60) + '|req=' + (e.required || e.getAttribute('aria-required') === 'true'));
  }
  var btns = [];
  var bs = document.querySelectorAll('button, a');
  for (var j = 0; j < bs.length; j++) {
    var t = norm(bs[j].textContent);
    if (t && t.length < 40 && (bs[j].offsetWidth || bs[j].offsetHeight)) btns.push(t);
  }
  return { campos: out, botones: btns, url: location.href };
})()`;
for (const sufijo of ['/application']) {
  const url = 'https://jobs.ashbyhq.com/possible-finance/d33db597-0b1f-4170-9095-9c32b6b18443' + sufijo;
  console.log('=====', sufijo || '(base)');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log('goto err', String(e).slice(0, 100)));
  await page.waitForTimeout(5000);
  const d = await page.evaluate(DUMP).catch(() => null);
  if (!d) { console.log('sin dump'); continue; }
  console.log('URL:', d.url);
  console.log('BOTONES:', d.botones.join(' · '));
  console.log('CAMPOS:', d.campos.length);
  d.campos.forEach((c) => console.log('  ', c));
  if (sufijo === '') await page.screenshot({ path: '/tmp/ashby-base.png' });
  else await page.screenshot({ path: '/tmp/ashby-app.png' });
}
await browser.close();
