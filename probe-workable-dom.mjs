/** Volcado del DOM alrededor de los radios del formulario Workable. */
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
const out = await page.evaluate(`(function () {
  var radios = document.querySelectorAll('input[type="radio"]');
  var res = [];
  for (var i = 0; i < radios.length; i++) {
    var r = radios[i];
    var cadena = [];
    var n = r;
    for (var k = 0; n && k < 7; k++) {
      cadena.push(n.tagName + '.' + (typeof n.className === 'string' ? n.className.slice(0, 60) : '') + ' :: ' + (n.textContent || '').trim().slice(0, 90).replace(/\\n/g, ' | '));
      n = n.parentElement;
    }
    res.push({ name: r.name, id: r.id, cadena: cadena });
  }
  var salary = document.querySelectorAll('input[type="text"]');
  var sal = [];
  for (var j = 0; j < salary.length; j++) {
    var cadena2 = [];
    var m = salary[j];
    for (var k2 = 0; m && k2 < 5; k2++) {
      cadena2.push(m.tagName + '.' + (typeof m.className === 'string' ? m.className.slice(0, 50) : '') + ' :: ' + (m.textContent || '').trim().slice(0, 70).replace(/\\n/g, ' | '));
      m = m.parentElement;
    }
    sal.push({ id: salary[j].id, name: salary[j].name, cadena: cadena2 });
  }
  return { radios: res.slice(0, 2), textos: sal };
})()`);
console.log(JSON.stringify(out, null, 1).slice(0, 4200));
await browser.close();
