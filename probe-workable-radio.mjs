/** Prueba de estrategias para marcar el radio NO en Workable. */
const { cargarPlaywright, resolveChromiumExe } = await import('/app/apps/backend/dist/sender/driver.js');
const chromium = cargarPlaywright();
const browser = await chromium.launch({
  executablePath: resolveChromiumExe(),
  headless: true,
  args: ['--ignore-certificate-errors', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1360, height: 1100 } });
await page.goto(process.argv[2], { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4000);

// Localiza el radio NO y marca su etiqueta envolvente con un id.
const idRadio = await page.evaluate(`(function () {
  var radios = document.querySelectorAll('input[type="radio"]');
  for (var i = 0; i < radios.length; i++) {
    var lab = radios[i].closest('label');
    if (lab && (lab.textContent || '').trim().toUpperCase() === 'NO') {
      lab.setAttribute('data-probe-label', 'no');
      return radios[i].id;
    }
  }
  return null;
})()`);
console.log('radio NO id:', idRadio);
const estado = async () =>
  page.evaluate(`(function () {
    var r = document.querySelector('input[type="radio"]:checked');
    return r ? (r.closest('label') ? (r.closest('label').textContent || '').trim() : r.id) : 'NINGUNO';
  })()`);
console.log('antes:', await estado());
const label = await page.$('[data-probe-label="no"]');
if (label) {
  await label.click({ timeout: 8000 }).catch((e) => console.log('click label error:', String(e).split('\n')[0]));
  await page.waitForTimeout(900);
  console.log('tras click REAL en label:', await estado());
}
await browser.close();
