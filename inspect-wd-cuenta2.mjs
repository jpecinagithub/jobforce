/** Inspección paciente del paso 1: reintenta «Sign in with email». */
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
    var els = document.querySelectorAll('a, button, [role="button"]');
    for (var i = 0; i < els.length; i++) {
      if ((els[i].offsetWidth || els[i].offsetHeight) && norm(els[i].textContent) === t) { els[i].click(); return true; }
    }
    return false;
  })('${t}')`);
await page.goto(process.argv[2], { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(5000);
console.log('apply:', await clickTxt('apply'));
await page.waitForTimeout(3000);
console.log('autofill:', await clickTxt('autofill with resume'));
let emailForm = false;
for (let i = 0; i < 14 && !emailForm; i++) {
  await page.waitForTimeout(2500);
  const dump = await page.evaluate(`(function () {
    function norm(s) { return (s || '').replace(/\\s+/g, ' ').trim(); }
    var btns = [];
    var els = document.querySelectorAll('a, button, [role="button"]');
    for (var j = 0; j < els.length; j++) {
      var t = norm(els[j].textContent);
      if (t && t.length < 45 && (els[j].offsetWidth || els[j].offsetHeight)) btns.push(t);
    }
    var inputs = [];
    var ins = document.querySelectorAll('input');
    for (var k = 0; k < ins.length; k++) {
      inputs.push(ins[k].type + '|id=' + (ins[k].id || '') + '|name=' + (ins[k].name || '') + '|aid=' + (ins[k].getAttribute('data-automation-id') || '') + '|aria=' + (ins[k].getAttribute('aria-label') || ''));
    }
    return { btns: btns, inputs: inputs };
  })()`);
  console.log(`r${i} botones:`, dump.btns.join(' · ').slice(0, 260));
  if (dump.inputs.length) {
    console.log('INPUTS:');
    dump.inputs.forEach((x) => console.log('  ', x));
    emailForm = true;
    break;
  }
  if (dump.btns.some((b) => b === 'sign in with email')) {
    console.log('click sign in with email:', await clickTxt('sign in with email'));
  }
}
await page.screenshot({ path: '/tmp/wd-cuenta2.png' });
await browser.close();
