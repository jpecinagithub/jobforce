/** Prueba 2: pill, force-click y teclado para el radio de Workable. */
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
const estado = async () =>
  page.evaluate(`(function () {
    var r = document.querySelector('input[type="radio"]:checked');
    return r ? (r.closest('label') ? (r.closest('label').textContent || '').trim() : r.id) : 'NINGUNO';
  })()`);

// Marca el pill (ancestro div del label) del radio NO.
await page.evaluate(`(function () {
  var radios = document.querySelectorAll('input[type="radio"]');
  for (var i = 0; i < radios.length; i++) {
    var lab = radios[i].closest('label');
    if (lab && (lab.textContent || '').trim().toUpperCase() === 'NO') {
      var pill = lab.parentElement;
      if (pill) pill.setAttribute('data-probe-pill', 'no');
      radios[i].setAttribute('data-probe-radio', 'no');
      return;
    }
  }
})()`);
const pill = await page.$('[data-probe-pill="no"]');
if (pill) {
  await pill.click({ timeout: 8000 }).catch((e) => console.log('pill click error:', String(e).split('\n')[0]));
  await page.waitForTimeout(800);
  console.log('tras click en pill:', await estado());
}
if ((await estado()) === 'NINGUNO' && pill) {
  await pill.click({ force: true, timeout: 8000 }).catch((e) => console.log('pill force error:', String(e).split('\n')[0]));
  await page.waitForTimeout(800);
  console.log('tras force click en pill:', await estado());
}
if ((await estado()) === 'NINGUNO') {
  await page.evaluate(`(function () { var r = document.querySelector('[data-probe-radio="no"]'); if (r) r.focus(); return !!r; })()`);
  await page.keyboard.press('Space');
  await page.waitForTimeout(800);
  console.log('tras foco + Space:', await estado());
}
if ((await estado()) === 'NINGUNO') {
  await page.evaluate(`(function () { var r = document.querySelector('[data-probe-radio="no"]'); if (r) r.click(); })()`);
  await page.waitForTimeout(800);
  console.log('tras r.click() JS:', await estado());
}
await browser.close();
