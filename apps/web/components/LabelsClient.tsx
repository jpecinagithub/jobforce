'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';

interface Oferta {
  offer_id: string;
  title: string | null;
  company: string | null;
  url: string;
  score: number | null;
  encaja: boolean | null;
  encaja_real: boolean | null;
  nota: string | null;
}

interface Correo {
  mensaje_id: string;
  asunto: string | null;
  remitente: string | null;
  fecha: string | null;
  predicha: string | null;
  clasificacion_real: string | null;
  nota: string | null;
}

interface PrecisionReport {
  umbral_encaje: number;
  encaje: {
    n: number;
    mensaje?: string;
    vp?: number;
    fp?: number;
    fn?: number;
    vn?: number;
    sin_evaluacion?: number;
    precision?: number | null;
    recall?: number | null;
  };
  correos: {
    n: number;
    mensaje?: string;
    con_prediccion?: number;
    correctas?: number;
    errores?: number;
    exactitud?: number | null;
    matriz?: Record<string, number>;
  };
}

const CLASIFICACIONES: Array<{ valor: string; etiqueta: string }> = [
  { valor: '', etiqueta: '— sin etiqueta —' },
  { valor: 'confirmacion', etiqueta: 'Confirmación' },
  { valor: 'rechazo', etiqueta: 'Rechazo' },
  { valor: 'entrevista', etiqueta: 'Entrevista' },
  { valor: 'ambiguo', etiqueta: 'Ambiguo' },
  { valor: 'otro', etiqueta: 'Otro' },
];

function nombreClasificacion(v: string | null): string {
  const c = CLASIFICACIONES.find((x) => x.valor === v);
  return c ? c.etiqueta : (v ?? '—').replaceAll('_', ' ');
}

function formatoFecha(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('es-ES');
}

async function leerJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detalle = `El backend respondió ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; detalle?: string };
      detalle = body.detalle ?? body.error ?? detalle;
    } catch {
      /* se usa el genérico */
    }
    throw new Error(detalle);
  }
  return (await res.json()) as T;
}

export default function LabelsClient() {
  const { mutatingHeaders } = useAuth();
  const [tab, setTab] = useState<'ofertas' | 'correos' | 'precision'>('ofertas');

  const [ofertas, setOfertas] = useState<Oferta[]>([]);
  const [totalOfertas, setTotalOfertas] = useState(0);
  const [etiquetadasOfertas, setEtiquetadasOfertas] = useState(0);
  const [soloSinOfertas, setSoloSinOfertas] = useState(false);

  const [correos, setCorreos] = useState<Correo[]>([]);
  const [totalCorreos, setTotalCorreos] = useState(0);
  const [etiquetadosCorreos, setEtiquetadosCorreos] = useState(0);
  const [soloSinCorreos, setSoloSinCorreos] = useState(false);

  const [informe, setInforme] = useState<PrecisionReport | null>(null);

  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [notas, setNotas] = useState<Record<string, string>>({});
  const [aviso, setAviso] = useState<string | null>(null);

  const cargarOfertas = useCallback(async () => {
    const qs = soloSinOfertas ? '?solo_sin_etiqueta=true' : '';
    const data = await leerJson<{ ofertas: Oferta[]; total: number; etiquetadas: number }>(
      await fetch(`/api/labels/offers${qs}`),
    );
    setOfertas(data.ofertas);
    setTotalOfertas(data.total);
    setEtiquetadasOfertas(data.etiquetadas);
  }, [soloSinOfertas]);

  const cargarCorreos = useCallback(async () => {
    const qs = soloSinCorreos ? '?solo_sin_etiqueta=true' : '';
    const data = await leerJson<{ correos: Correo[]; total: number; etiquetados: number }>(
      await fetch(`/api/labels/emails${qs}`),
    );
    setCorreos(data.correos);
    setTotalCorreos(data.total);
    setEtiquetadosCorreos(data.etiquetados);
  }, [soloSinCorreos]);

  const cargarInforme = useCallback(async () => {
    const data = await leerJson<PrecisionReport>(await fetch('/api/metricas/precision'));
    setInforme(data);
  }, []);

  const cargarTodo = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      await Promise.all([cargarOfertas(), cargarCorreos(), cargarInforme()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al cargar');
    } finally {
      setCargando(false);
    }
  }, [cargarOfertas, cargarCorreos, cargarInforme]);

  useEffect(() => {
    void cargarTodo();
  }, [cargarTodo]);

  async function etiquetarOferta(oferta: Oferta, encajaReal: boolean) {
    setOcupado(oferta.offer_id);
    setAviso(null);
    try {
      const nota = (notas[oferta.offer_id] ?? '').trim();
      await leerJson(
        await fetch('/api/labels/offers', {
          method: 'POST',
          headers: mutatingHeaders(),
          body: JSON.stringify({
            offer_id: oferta.offer_id,
            encaja_real: encajaReal,
            ...(nota ? { nota } : {}),
          }),
        }),
      );
      setNotas((n) => ({ ...n, [oferta.offer_id]: '' }));
      await cargarOfertas();
      await cargarInforme();
      setAviso(`Etiqueta guardada: "${oferta.title ?? oferta.offer_id}" → ${encajaReal ? 'sí encaja' : 'no encaja'}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar la etiqueta');
    } finally {
      setOcupado(null);
    }
  }

  async function etiquetarCorreo(correo: Correo, clasificacionReal: string) {
    if (!clasificacionReal) return;
    setOcupado(correo.mensaje_id);
    setAviso(null);
    try {
      const nota = (notas[correo.mensaje_id] ?? '').trim();
      await leerJson(
        await fetch('/api/labels/emails', {
          method: 'POST',
          headers: mutatingHeaders(),
          body: JSON.stringify({
            mensaje_id: correo.mensaje_id,
            clasificacion_real: clasificacionReal,
            ...(nota ? { nota } : {}),
          }),
        }),
      );
      setNotas((n) => ({ ...n, [correo.mensaje_id]: '' }));
      await cargarCorreos();
      await cargarInforme();
      setAviso(`Etiqueta guardada: "${correo.asunto ?? correo.mensaje_id}" → ${nombreClasificacion(clasificacionReal)}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar la etiqueta');
    } finally {
      setOcupado(null);
    }
  }

  if (cargando) return <p className="muted">Cargando…</p>;

  return (
    <div>
      {error && (
        <div className="error" role="alert">
          {error}{' '}
          <button type="button" className="btn btn-small btn-ghost" onClick={() => void cargarTodo()}>
            Reintentar
          </button>
        </div>
      )}
      {aviso && <div className="notice">{aviso}</div>}

      <div style={{ display: 'flex', gap: '0.5rem', margin: '1.5rem 0' }} role="tablist" aria-label="Etiquetado">
        {(
          [
            ['ofertas', 'Ofertas'],
            ['correos', 'Correos'],
            ['precision', 'Precisión'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'btn btn-small' : 'btn btn-small btn-ghost'}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'ofertas' && (
        <section>
          <h2>Ofertas</h2>
          <p className="muted">
            <strong>
              {etiquetadasOfertas} de {totalOfertas} etiquetadas
            </strong>
            . Lee cada oferta y decide con tu criterio: <strong>¿la enviarías tú?</strong>{' '}
            Si puedes, decide <em>antes</em> de mirar la predicción del sistema.
          </p>
          <label className="field check">
            <input
              type="checkbox"
              checked={soloSinOfertas}
              onChange={(e) => setSoloSinOfertas(e.target.checked)}
            />
            Mostrar solo las sin etiquetar
          </label>
          {ofertas.length === 0 ? (
            <div className="notice">No hay ofertas pendientes (o aún no hay ofertas evaluadas).</div>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Empresa / Puesto</th>
                  <th>Score</th>
                  <th>Predicción</th>
                  <th>Tu etiqueta</th>
                  <th>Acción</th>
                </tr>
              </thead>
              <tbody>
                {ofertas.map((o) => (
                  <tr key={o.offer_id}>
                    <td>
                      <strong>{o.company ?? '—'}</strong>
                      <br />
                      <span className="muted">{o.title ?? '—'}</span>
                      {o.url && (
                        <>
                          <br />
                          <a href={o.url} target="_blank" rel="noopener noreferrer">
                            Ver oferta ↗
                          </a>
                        </>
                      )}
                    </td>
                    <td>{o.score ?? '—'}</td>
                    <td>
                      {o.encaja === null ? (
                        <span className="muted">sin evaluar</span>
                      ) : o.encaja ? (
                        <span className="badge active">encaja (≥70)</span>
                      ) : (
                        <span className="badge pending">no encaja (&lt;70)</span>
                      )}
                    </td>
                    <td>
                      {o.encaja_real === null ? (
                        <span className="muted">sin etiquetar</span>
                      ) : o.encaja_real ? (
                        <span className="badge active">sí encaja</span>
                      ) : (
                        <span className="badge danger">no encaja</span>
                      )}
                    </td>
                    <td>
                      <input
                        type="text"
                        placeholder="Nota (opcional)"
                        style={{ width: '100%', marginBottom: '0.25rem' }}
                        value={notas[o.offer_id] ?? ''}
                        onChange={(e) => setNotas((n) => ({ ...n, [o.offer_id]: e.target.value }))}
                        maxLength={500}
                        aria-label="Nota de la etiqueta"
                      />
                      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                        <button
                          type="button"
                          className="btn btn-small"
                          disabled={ocupado === o.offer_id}
                          onClick={() => void etiquetarOferta(o, true)}
                        >
                          Sí encaja
                        </button>
                        <button
                          type="button"
                          className="btn btn-small btn-ghost"
                          disabled={ocupado === o.offer_id}
                          onClick={() => void etiquetarOferta(o, false)}
                        >
                          No encaja
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {tab === 'correos' && (
        <section>
          <h2>Correos</h2>
          <p className="muted">
            <strong>
              {etiquetadosCorreos} de {totalCorreos} etiquetados
            </strong>
            . Clasifica cada mensaje según lo que <strong>realmente es</strong> (no lo que dice el
            sistema). Si puedes, decide <em>antes</em> de mirar la clasificación predicha.
          </p>
          <label className="field check">
            <input
              type="checkbox"
              checked={soloSinCorreos}
              onChange={(e) => setSoloSinCorreos(e.target.checked)}
            />
            Mostrar solo los sin etiquetar
          </label>
          {correos.length === 0 ? (
            <div className="notice">No hay mensajes pendientes en el seguimiento.</div>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Asunto / Remitente</th>
                  <th>Fecha</th>
                  <th>Predicha</th>
                  <th>Tu etiqueta</th>
                </tr>
              </thead>
              <tbody>
                {correos.map((c) => (
                  <tr key={c.mensaje_id}>
                    <td>
                      <strong>{c.asunto ?? '—'}</strong>
                      <br />
                      <span className="muted">{c.remitente ?? '—'}</span>
                    </td>
                    <td>{formatoFecha(c.fecha)}</td>
                    <td>
                      <span className="badge">{nombreClasificacion(c.predicha)}</span>
                    </td>
                    <td>
                      <select
                        aria-label="Clasificación real"
                        style={{ width: '100%', marginBottom: '0.25rem' }}
                        defaultValue={c.clasificacion_real ?? ''}
                        disabled={ocupado === c.mensaje_id}
                        onChange={(e) => void etiquetarCorreo(c, e.target.value)}
                      >
                        {CLASIFICACIONES.map((opt) => (
                          <option key={opt.valor} value={opt.valor}>
                            {opt.etiqueta}
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        placeholder="Nota (opcional)"
                        style={{ width: '100%', marginBottom: '0.25rem' }}
                        value={notas[c.mensaje_id] ?? ''}
                        onChange={(e) => setNotas((n) => ({ ...n, [c.mensaje_id]: e.target.value }))}
                        maxLength={500}
                        aria-label="Nota de la etiqueta"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {tab === 'precision' && (
        <section>
          <h2>Precisión</h2>
          <p className="muted">
            Se calcula <strong>solo</strong> con tus etiquetas reales frente a lo que predijo el
            sistema. La confianza que declara el modelo no cuenta: lo único que vale es tu criterio.
          </p>
          {!informe ? (
            <div className="notice">Todavía no hay informe.</div>
          ) : (
            <div className="cards">
              <div className="card">
                <h3>Encaje de ofertas</h3>
                {informe.encaje.n === 0 ? (
                  <p className="muted">{informe.encaje.mensaje}</p>
                ) : (
                  <>
                    <p className="big">{informe.encaje.n}</p>
                    <p className="label">ofertas etiquetadas y evaluadas</p>
                    <p>
                      <strong>Precisión:</strong> {informe.encaje.precision ?? '—'}{' '}
                      <span className="muted">
                        (de las que el sistema dijo que encajaban, ¿cuántas encajaban de verdad?{' '}
                        {informe.encaje.vp}/{Number(informe.encaje.vp) + Number(informe.encaje.fp)})
                      </span>
                    </p>
                    <p>
                      <strong>Recall:</strong> {informe.encaje.recall ?? '—'}{' '}
                      <span className="muted">
                        (de las que encajaban de verdad, ¿cuántas detectó el sistema?{' '}
                        {informe.encaje.vp}/{Number(informe.encaje.vp) + Number(informe.encaje.fn)})
                      </span>
                    </p>
                    <p className="muted">
                      Aciertos: {informe.encaje.vp} (sí/sí) · {informe.encaje.vn} (no/no) — Errores:{' '}
                      {informe.encaje.fp} dijo que sí y era no · {informe.encaje.fn} dijo que no y era
                      sí.
                      {(informe.encaje.sin_evaluacion ?? 0) > 0 &&
                        ` ${informe.encaje.sin_evaluacion} etiqueta(s) sin evaluación: no cuentan.`}
                    </p>
                  </>
                )}
              </div>
              <div className="card">
                <h3>Clasificación de correos</h3>
                {informe.correos.n === 0 ? (
                  <p className="muted">{informe.correos.mensaje}</p>
                ) : (
                  <>
                    <p className="big">{informe.correos.n}</p>
                    <p className="label">correos etiquetados</p>
                    <p>
                      <strong>Exactitud:</strong> {informe.correos.exactitud ?? '—'}{' '}
                      <span className="muted">
                        ({informe.correos.correctas} aciertos de {informe.correos.con_prediccion} con
                        predicción; {informe.correos.errores} errores)
                      </span>
                    </p>
                    {informe.correos.matriz && Object.keys(informe.correos.matriz).length > 0 && (
                      <details>
                        <summary>Matriz de confusión (predicha → real)</summary>
                        <ul>
                          {Object.entries(informe.correos.matriz)
                            .sort((a, b) => b[1] - a[1])
                            .map(([clave, cuenta]) => (
                              <li key={clave}>
                                <code>{clave}</code>: {cuenta}
                              </li>
                            ))}
                        </ul>
                      </details>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </section>
      )}

    </div>
  );
}
