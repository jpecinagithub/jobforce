/** Ejecuta el WorkdayDriver compilado directamente (depuración). */
process.env.HOME = '/home/app';
const { WorkdayDriver } = await import('/app/apps/backend/dist/sender/workday-driver.js');
const { obtenerOCrearCuentaPortal } = await import('/app/apps/backend/dist/sender/portal-accounts.js');
const { loadConfig } = await import('/app/packages/config/dist/index.js');
const { createDb } = await import('/app/packages/database/dist/index.js');
import { mkdirSync } from 'node:fs';

const config = loadConfig(process.env);
const { db, pool } = createDb(config.databaseUrl);
const host = 'clr.wd5.myworkdayjobs.com';
const cuenta = await obtenerOCrearCuentaPortal(config, db, host, 'jpecina@gmail.com', null);
console.log('cuenta:', cuenta.email, 'creada:', cuenta.creada);
const shots = '/tmp/wd-shots';
mkdirSync(shots, { recursive: true });
const job = {
  sendId: 'debug-1',
  applicationId: 'debug',
  portal: 'workday',
  applyUrl: 'https://clr.wd5.myworkdayjobs.com/en-US/CLR_Careers/job/International-Accounting---Finance-Manager_R02656',
  campos: [],
  cvPath: '/home/app/workspace/jobforce/documents/790708ed-6c7a-4da9-8352-cd8f8bf274a1/cv-v1.pdf',
  cartaPath: '/home/app/workspace/jobforce/documents/790708ed-6c7a-4da9-8352-cd8f8bf274a1/carta-v1.pdf',
  docCvSelector: 'input[type="file"]',
  docCartaSelector: 'input[type="file"]',
  shotsDir: shots,
  submitButtonName: 'submit application',
  etiquetas: {
    nombre: 'Jon',
    apellidos: 'Peciña Iturbe',
    email: 'jpecina@gmail.com',
    telefono: '+34634605035',
    ubicacion: 'Logroño, Spain',
    paisResidencia: 'Spain',
    linkedin: 'https://www.linkedin.com/in/jpecina',
    salarioEsperado: '80000 EUR',
    cuentaEmail: cuenta.email,
    cuentaPassword: cuenta.password,
  },
};
const driver = new WorkdayDriver();
try {
  const r = await driver.preparar(job);
  console.log('PREPARAR OK:', JSON.stringify(r).slice(0, 400));
} catch (e) {
  console.log('PREPARAR ERROR:', e?.tipo ?? '', String(e?.message ?? e).slice(0, 300));
}
await pool.end().catch(() => undefined);
process.exit(0);
