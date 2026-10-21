/** Inspección de solo lectura de la pantalla de acceso iCIMS. */
import { createRequire } from 'node:module';
const require2 = createRequire('/app/apps/backend/dist/sender/driver.js');
const pw = require2('playwright-core');
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const exeCandidates = [
  process.env.PLAYWRIGHT_CHROMIUM_EXE,
  '/root/.cache/ms-playwright/chromium-1181/chrome-linux/chrome',
].filter(Boolean);
let exe = exeCandidates.find((p) => p && existsSync(p));
if (!exe) {
  const found = execSync('find / -name "headless_shell" -o -name "chrome" -type f 2>/dev/null | grep -i playwright | head -3').toString().trim().split('\n')[0];
  exe = found || undefined;
}
console.log('EXE', exe);
const browser = await pw.chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--ignore-certificate-errors', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({
  viewport: { width: 1360, height: 1000 },
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
});
await page.goto('https://careers-sightsavers.icims.com/jobs/1669/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4000);
console.log('URL', page.url());
console.log('FRAMES', page.frames().length);
for (const f of page.frames()) {
  const info = await f.evaluate(`(function () {
    var btns = [];
    var nodes = document.querySelectorAll('button, input[type="submit"], input[type="button"], a');
    for (var i = 0; i < nodes.length; i++) {
      var b = nodes[i];
      var t = ((b.textContent || b.value || '')).trim().slice(0, 60);
      if (t) btns.push({ tag: b.tagName, type: b.getAttribute('type'), role: b.getAttribute('role'), disabled: !!b.disabled, visible: !!(b.offsetWidth || b.offsetHeight), text: t });
    }
    var checks = [];
    var cs = document.querySelectorAll('input[type="checkbox"]');
    for (var j = 0; j < cs.length; j++) {
      var c = cs[j];
      var lbl = '';
      var n = c; for (var k = 0; n && k < 6; k++) { var tx = (n.textContent || '').trim(); if (tx) { lbl = tx.slice(0, 120); break; } n = n.parentElement; }
      checks.push({ id: c.id, name: c.name, visible: !!(c.offsetWidth || c.offsetHeight), checked: c.checked, ctx: lbl });
    }
    var inputs = [];
    var ins = document.querySelectorAll('input');
    for (var m = 0; m < ins.length; m++) inputs.push({ type: ins[m].getAttribute('type'), id: ins[m].id, name: ins[m].name, visible: !!(ins[m].offsetWidth || ins[m].offsetHeight) });
    return { btns: btns.slice(0, 14), checks: checks, inputs: inputs.slice(0, 12) };
  })()`).catch((e) => ({ error: String(e) }));
  console.log('FRAME', f.url().slice(0, 90), JSON.stringify(info, null, 1).slice(0, 2600));
}
await browser.close();
