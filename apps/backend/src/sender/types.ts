/**
 * @jobforce/backend — Ejecutor de envíos: tipos del puerto del navegador.
 *
 * El ejecutor (`executor.ts`) orquesta; el navegador es un puerto
 * (`BrowserDriver`) con dos implementaciones: el driver real de Playwright
 * (`driver.ts`, adaptado del flujo probado en vivo en Fase 3) y los dobles
 * de los tests. El ejecutor NUNCA habla con Playwright directamente.
 */

/** Clases de anomalía que el driver puede encontrar. Nunca se fuerzan. */
export type AnomaliaKind =
  | 'captcha_mfa' // desafío CAPTCHA/MFA real y visible
  | 'oferta_cerrada' // la oferta se cerró entre la verificación y el envío
  | 'formulario_cambiado' // selectores ausentes o campos nuevos no previstos
  | 'datos_ausentes' // faltan documentos, config del formulario o ficheros
  | 'portal_no_soportado' // portal sin driver probado (honesto, no simulado)
  | 'error_ambiguo'; // error técnico ambiguo (red, crash, subida sin confirmar)

/**
 * Error lanzado por el driver ante una anomalía. El ejecutor lo convierte
 * en intervención con contexto; jamás reintenta a ciegas.
 */
export class AnomaliaEnvio extends Error {
  readonly kind: AnomaliaKind;
  /**
   * true si la anomalía ocurrió DESPUÉS de pulsar Submit: el estado del
   * envío es incierto y exige conciliación (contrato de `reconcile.ts`).
   * false si ocurrió antes: nada se envió.
   */
  readonly trasClick: boolean;
  readonly contexto: Record<string, unknown>;

  constructor(
    kind: AnomaliaKind,
    message: string,
    opts: { trasClick?: boolean; contexto?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'AnomaliaEnvio';
    this.kind = kind;
    this.trasClick = opts.trasClick ?? false;
    this.contexto = opts.contexto ?? {};
  }
}

/** Un campo del formulario: selector + cómo rellenarlo + valor aprobado. */
export interface CampoFormulario {
  selector: string;
  tipo: 'fill' | 'select';
  valor: string;
  /** Etiqueta legible para logs y evidencias (p. ej. "email"). */
  etiqueta: string;
}

/** Todo lo que el driver necesita para un envío. Sin secretos. */
export interface DriverJob {
  sendId: string;
  applicationId: string;
  portal: string;
  /** URL de la página de solicitud (p. ej. `.../apply?language=nul`). */
  applyUrl: string;
  campos: CampoFormulario[];
  /** Rutas absolutas a los PDF ya verificados (sha256 comprobado). */
  cvPath: string;
  cartaPath: string;
  /** Selectores de los inputs de fichero (defaults de Personio). */
  docCvSelector: string;
  docCartaSelector: string;
  /** Directorio donde guardar las capturas de evidencia. */
  shotsDir: string;
  /** Nombre del botón de envío (fuente de RegExp, p. ej. "submit application"). */
  submitButtonName: string;
}

export interface AperturaResultado {
  abierta: boolean;
  detalle: string;
}

export interface PreparacionResultado {
  camposRellenados: number;
  uploadsOk: boolean;
  capturas: string[];
}

export interface ConfirmacionEnvio {
  /** Texto de éxito detectado en la página (recortado). */
  mensaje: string;
  urlTrasEnvio: string;
  /** Referencia/ID de candidatura si el portal la muestra (puede ser null). */
  referencia: string | null;
  capturas: string[];
}

export interface ResultadoDriver {
  /** true = confirmación capturada; false = estado incierto (conciliar). */
  confirmado: boolean;
  confirmacion?: ConfirmacionEnvio;
  capturas: string[];
  evidencia: Record<string, unknown>;
}

/**
 * Puerto del navegador. Implementaciones: `PersonioDriver` (real) y los
 * dobles de los tests. El ciclo de vida lo controla el ejecutor:
 * verificarApertura → preparar → enviarYConfirmar → cerrar (siempre).
 */
export interface BrowserDriver {
  readonly portal: string;
  /** Abre la página y verifica que la oferta sigue abierta. Mantiene la sesión. */
  verificarApertura(job: DriverJob): Promise<AperturaResultado>;
  /** Rellena el formulario, sube los documentos y re-verifica antes de enviar. */
  preparar(job: DriverJob): Promise<PreparacionResultado>;
  /** Un solo clic en Submit + captura de la confirmación. */
  enviarYConfirmar(job: DriverJob): Promise<ResultadoDriver>;
  /** Cierra el navegador y el forwarder. Siempre se llama (finally). */
  cerrar(): Promise<void>;
}

/** Resultado de procesar un envío. */
export type ResultadoProceso =
  | {
      procesado: true;
      estado: 'sent' | 'uncertain' | 'failed';
      sendId: string;
      detalle: string;
      interventionId?: string;
    }
  | { procesado: false; motivo: string; sendId: string };
