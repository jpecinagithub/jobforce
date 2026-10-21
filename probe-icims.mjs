/** Sonda interactiva (no envía nada): reproduce acceso y mide estados. */
const { cargarPlaywright, resolveChromiumExe } = await import('/app/apps/backend/dist/sender/driver.js');
const chromium = cargarPlaywright();
const browser = await chromium.launch({
  executablePath: resolveChromiumExe(),
  headless: true,
  args: ['--ignore-certificate-errors', '--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
});
const page = await browser.newPage({
  viewport: { width: 1360, height: 1000 },
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  locale: 'en-US',
});
await page.goto('https://careers-sightsavers.icims.com/jobs/1669/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4000);
const frame = page.frames().find((f) => f.url().includes('in_iframe=1')) ?? page.mainFrame();
const estado = async (tag) => {
  const s = await frame.evaluate(`(function () {
    var b = document.querySelector('#enterEmailSubmitButton');
    var c = document.querySelector('#accept_gdpr');
    var tok = document.querySelector('[name="h-captcha-response"], [name="g-recaptcha-response"]');
    return { nextDisabled: b ? b.disabled : 'sin-boton', checked: c ? c.checked : 'sin-casilla', tokenLen: tok ? (tok.value || '').length : 'sin-token' };
  })()`);
  console.log(tag, JSON.stringify(s));
};
await estado('inicial');
await frame.fill('#email', 'jpecina@gmail.com');
await estado('tras-email');
// Clic real de Playwright sobre la casilla
try {
  await frame.click('#accept_gdpr', { timeout: 8000 });
  console.log('click Playwright OK');
} catch (e) {
  console.log('click Playwright FALLO:', String(e).split('\n')[0]);
}
await page.waitForTimeout(800);
await estado('tras-click-casilla');
// Clic en la etiqueta asociada, por si la casilla está cubierta
try {
  await frame.click('label[for="accept_gdpr"]', { timeout: 5000 });
  console.log('click label OK');
} catch (e) {
  console.log('click label FALLO:', String(e).split('\n')[0]);
}
await page.waitForTimeout(800);
await estado('tras-click-label');
// Click vía JS directo
await frame.evaluate(`(function () { var c = document.querySelector('#accept_gdpr'); if (c && !c.checked) c.click(); })()`);
await page.waitForTimeout(800);
await estado('tras-click-js');
await page.waitForTimeout(3000);
await estado('tras-espera-3s');
await browser.close();
