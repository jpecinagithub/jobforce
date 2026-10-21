/** Texto visible del formulario /apply/ de Workable (solo lectura). */
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
const t = await page.evaluate(`(function () { return (document.body.innerText || '').slice(0, 3000); })()`);
console.log(t);
await browser.close();
