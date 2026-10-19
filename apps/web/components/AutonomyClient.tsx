'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '@/lib/auth';
import {
  defaultReglas,
  parseApiError,
  toPolicyResponse,
  MODE_LABELS,
  MODE_DESCRIPTIONS,
} from '@/lib/autonomy';
import type {
  AutonomyStatus,
  ModoAutonomia,
  PolicyResponse,
  ReglasAutonomia,
} from '@/lib/autonomy';

const AUTONOMY_ENDPOINTS_MSG =
  'El backend aún no expone los endpoints de autonomía (pendiente del worker 2, contrato de fase 4). ' +
  'Esta página muestra el estado y el borrador contra ese contrato; guarda o autoriza cuando el backend esté listo.';

const MODES: ModoAutonomia[] = ['investigar', 'preparar_para_revision', 'ejecutar_automatico'];

interface LoadState {
  status: AutonomyStatus | null;
  policy: PolicyResponse | null;
  unavailable: boolean;
  loading: boolean;
}

/**
 * Frontal de autonomía (fase 4): estado actual, editor del borrador de la
 * política, autorización escrita, parada global y revocación.
 *
 * Contrato: GET /api/autonomy/status, GET /api/autonomy/policy,
 * PUT /api/autonomy/policy, POST /api/autonomy/policy/authorize|revoke,
 * POST /api/autonomy/stop|resume. Si un endpoint responde 404, se muestra
 * el aviso de "no disponible" en vez de inventar datos.
 */
export default function AutonomyClient() {
  const { mutatingHeaders } = useAuth();
  const [state, setState] = useState<LoadState>({ status: null, policy: null, unavailable: false, loading: true });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [sRes, pRes] = await Promise.all([
        fetch('/api/autonomy/status', { cache: 'no-store' }),
        fetch('/api/autonomy/policy', { cache: 'no-store' }),
      ]);
      if (sRes.status === 404 || pRes.status === 404) {
        setState({ status: null, policy: null, unavailable: true, loading: false });
        return;
      }
      if (!sRes.ok) throw new Error(await parseApiError(sRes));
      if (!pRes.ok) throw new Error(await parseApiError(pRes));
      const [status, policyRaw] = (await Promise.all([sRes.json(), pRes.json()])) as [
        AutonomyStatus,
        Parameters<typeof toPolicyResponse>[0],
      ];
      const policy = toPolicyResponse(policyRaw);
      setState({ status, policy, unavailable: false, loading: false });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'No se pudo conectar con el servidor.');
      setState((prev) => ({ ...prev, loading: false }));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // --- Estado del borrador del editor ------------------------------------
  const [modo, setModo] = useState<ModoAutonomia>('preparar_para_revision');
  const [reglas, setReglas] = useState<ReglasAutonomia>(defaultReglas());
  const [portalesRaw, setPortalesRaw] = useState('personio.com, workable.com, ashbyhq.com');
  const [empresasRaw, setEmpresasRaw] = useState('');
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Cuando el backend devuelve la política vigente, precarga el editor con ella.
  useEffect(() => {
    const pol = state.policy;
    if (pol?.reglas) {
      setModo(pol.modoActivo);
      setReglas(pol.reglas);
      setPortalesRaw((pol.reglas.portalesPermitidos ?? []).join(', '));
      setEmpresasRaw((pol.reglas.empresasExcluidas ?? []).join(', '));
    }
  }, [state.policy]);

  const set = <K extends keyof ReglasAutonomia>(key: K, value: ReglasAutonomia[K]) =>
    setReglas((r) => ({ ...r, [key]: value }));

  function reglasFromForm(): ReglasAutonomia | null {
    if (
      reglas.umbralEncajeRevision < 0 ||
      reglas.umbralEncajeRevision > 100 ||
      reglas.umbralEncajeAutomatico < 0 ||
      reglas.umbralEncajeAutomatico > 100
    ) {
      setSaveError('Los umbrales deben estar entre 0 y 100.');
      return null;
    }
    if (reglas.umbralEncajeAutomatico < reglas.umbralEncajeRevision) {
      setSaveError('El umbral automático no puede ser menor que el umbral de revisión.');
      return null;
    }
    return {
      ...reglas,
      portalesPermitidos: portalesRaw.split(',').map((s) => s.trim()).filter(Boolean),
      empresasExcluidas: empresasRaw.split(',').map((s) => s.trim()).filter(Boolean),
    };
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setSaveMsg(null);
    setSaveError(null);
    const body = reglasFromForm();
    if (!body) return;
    setBusy('save');
    try {
      const res = await fetch('/api/autonomy/policy', {
        method: 'PUT',
        headers: mutatingHeaders(),
        body: JSON.stringify({ modo, reglas: body }),
      });
      if (!res.ok) {
        setSaveError(await parseApiError(res));
        return;
      }
      const saved = (await res.json()) as Partial<PolicyResponse>;
      setSaveMsg(
        saved.version != null
          ? `Borrador guardado como versión ${saved.version}. Aún no está autorizado.`
          : 'Borrador guardado. Aún no está autorizado.',
      );
      await load();
    } catch {
      setSaveError('No se pudo conectar con el servidor.');
    } finally {
      setBusy(null);
    }
  }

  // --- Autorización escrita ------------------------------------------------
  const [leido, setLeido] = useState(false);
  const [autorizadoPor, setAutorizadoPor] = useState('');
  const [declaracion, setDeclaracion] = useState(
    'Autorizo a JOBFORCE a ejecutar la política de autonomía vigente según sus reglas y límites.',
  );
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  async function onAuthorize(e: FormEvent) {
    e.preventDefault();
    setAuthError(null);
    if (!leido) {
      setAuthError('Debes marcar la casilla de lectura y autorización explícita.');
      return;
    }
    if (autorizadoPor.trim().length === 0) {
      setAuthError('Indica tu nombre para firmar la autorización.');
      return;
    }
    setAuthBusy(true);
    try {
      const res = await fetch('/api/autonomy/policy/authorize', {
        method: 'POST',
        headers: mutatingHeaders(),
        body: JSON.stringify({ autorizadoPor: autorizadoPor.trim(), declaracion }),
      });
      if (!res.ok) {
        setAuthError(await parseApiError(res));
        return;
      }
      setLeido(false);
      await load();
    } catch {
      setAuthError('No se pudo conectar con el servidor.');
    } finally {
      setAuthBusy(false);
    }
  }

  // --- Acciones de parada / revocación ------------------------------------
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function post(path: string, label: string) {
    setActionMsg(null);
    setActionError(null);
    setBusy(label);
    try {
      const res = await fetch(path, { method: 'POST', headers: mutatingHeaders() });
      if (!res.ok) {
        setActionError(await parseApiError(res));
        return;
      }
      setActionMsg(label);
      await load();
    } catch {
      setActionError('No se pudo conectar con el servidor.');
    } finally {
      setBusy(null);
    }
  }

  const parada = state.status?.paradaGlobal ?? state.policy?.paradaGlobal ?? false;
  const autorizada = state.status?.autorizada ?? state.policy?.autorizacionEscrita != null;
  const autoBloqueado = modo === 'ejecutar_automatico' && !autorizada;

  return (
    <>
      {state.loading ? (
        <p className="muted">Cargando estado de autonomía…</p>
      ) : state.unavailable ? (
        <div className="notice" role="status">{AUTONOMY_ENDPOINTS_MSG}</div>
      ) : loadError ? (
        <div className="error" role="alert">{loadError}</div>
      ) : (
        <>
          <h2>Estado actual</h2>
          {parada && (
            <div className="alert-stop" role="alert">
              <strong>⛔ PARADA GLOBAL ACTIVA</strong> — el motor de autonomía está detenido por completo.
            </div>
          )}
          <dl className="fact">
            <dt>Modo activo</dt>
            <dd>{state.status?.modo ? MODE_LABELS[state.status.modo] : '—'}</dd>
            <dt>Versión de la política</dt>
            <dd>{state.status?.versionPolitica ?? state.policy?.version ?? '—'}</dd>
            <dt>Autorización escrita</dt>
            <dd>
              {state.policy?.autorizacionEscrita ? (
                <>
                  Vigente — firmada por <strong>{state.policy.autorizacionEscrita.autorizadoPor}</strong>
                  {' '}el {new Date(state.policy.autorizacionEscrita.fecha).toLocaleString('es-ES')}
                </>
              ) : (
                'No hay autorización escrita vigente'
              )}
            </dd>
            <dt>Envíos hoy</dt>
            <dd>{state.status?.enviosHoy ?? '—'}</dd>
            <dt>Gasto del mes</dt>
            <dd>{state.status?.gastoMesUsd != null ? `${state.status.gastoMesUsd.toFixed(2)} USD` : '—'}</dd>
          </dl>

          {autoBloqueado && (
            <div className="notice" role="status">
              <strong>Aviso:</strong> el modo «Ejecutar automático» está seleccionado en el borrador, pero sin
              autorización escrita vigente el envío automático <strong>queda bloqueado</strong> por el motor.
            </div>
          )}

          <h2>Parada global</h2>
          <p className="muted">
            La parada global detiene toda actividad del motor de autonomía de forma inmediata,
            sin importar el modo ni los límites de la política.
          </p>
          {actionMsg && <div className="notice" role="status">{actionMsg}</div>}
          {actionError && <div className="error" role="alert">{actionError}</div>}
          <div className="actions-row">
            {parada ? (
              <button type="button" className="btn" disabled={busy != null} onClick={() => post('/api/autonomy/resume', 'Autonomía reanudada.')}>
                {busy ? 'Procesando…' : '▶ Reanudar autonomía'}
              </button>
            ) : (
              <button type="button" className="btn btn-danger btn-big" disabled={busy != null} onClick={() => post('/api/autonomy/stop', 'Parada global activada.')}>
                {busy ? 'Procesando…' : '⛔ PARADA GLOBAL'}
              </button>
            )}
            {autorizada && (
              <button type="button" className="btn btn-ghost" disabled={busy != null} onClick={() => post('/api/autonomy/policy/revoke', 'Autorización escrita revocada.')}>
                Revocar autorización
              </button>
            )}
          </div>
        </>
      )}

      <h2>Editor del borrador de política</h2>
      <p className="muted">
        Define las reglas y guarda el borrador (PUT /api/autonomy/policy). El borrador guardado no entra en vigor
        para envíos automáticos hasta que firmes la autorización escrita de abajo.
      </p>
      {saveMsg && <div className="notice" role="status">{saveMsg}</div>}
      {saveError && <div className="error" role="alert">{saveError}</div>}
      <form className="form" style={{ maxWidth: 640 }} onSubmit={onSave}>
        <div className="field">
          <label>Modo del borrador</label>
          <div className="mode-cards">
            {MODES.map((m) => (
              <label key={m} className={`mode-card${modo === m ? ' selected' : ''}`}>
                <input
                  type="radio"
                  name="modo"
                  checked={modo === m}
                  onChange={() => setModo(m)}
                />
                <strong>{MODE_LABELS[m]}</strong>
                <span className="muted">{MODE_DESCRIPTIONS[m]}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="aut-u-rev">Umbral de encaje para revisión (%)</label>
            <input
              id="aut-u-rev"
              type="number" min={0} max={100}
              value={reglas.umbralEncajeRevision}
              onChange={(e) => set('umbralEncajeRevision', Number(e.target.value))}
            />
          </div>
          <div className="field">
            <label htmlFor="aut-u-auto">Umbral de encaje automático (%)</label>
            <input
              id="aut-u-auto"
              type="number" min={0} max={100}
              value={reglas.umbralEncajeAutomatico}
              onChange={(e) => set('umbralEncajeAutomatico', Number(e.target.value))}
            />
          </div>
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="aut-d">Máx. envíos por día</label>
            <input
              id="aut-d"
              type="number" min={1} max={100}
              value={reglas.maxEnviosPorDia}
              onChange={(e) => set('maxEnviosPorDia', Number(e.target.value))}
            />
          </div>
          <div className="field">
            <label htmlFor="aut-s">Máx. envíos por semana</label>
            <input
              id="aut-s"
              type="number" min={1} max={200}
              value={reglas.maxEnviosPorSemana}
              onChange={(e) => set('maxEnviosPorSemana', Number(e.target.value))}
            />
          </div>
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="aut-p">Presupuesto mensual total (USD)</label>
            <input
              id="aut-p"
              type="number" min={0} step="0.01"
              value={reglas.presupuestoMensualUsd}
              onChange={(e) => set('presupuestoMensualUsd', Number(e.target.value))}
            />
          </div>
          <div className="field">
            <label htmlFor="aut-pe">Presupuesto Exa mensual (USD)</label>
            <input
              id="aut-pe"
              type="number" min={0} step="0.01"
              value={reglas.presupuestoExaMensualUsd}
              onChange={(e) => set('presupuestoExaMensualUsd', Number(e.target.value))}
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="aut-portales">Portales permitidos (separados por comas)</label>
          <input
            id="aut-portales"
            value={portalesRaw}
            onChange={(e) => setPortalesRaw(e.target.value)}
            placeholder="personio.com, workable.com"
          />
        </div>
        <div className="field">
          <label htmlFor="aut-empresas">Empresas excluidas (separadas por comas)</label>
          <input
            id="aut-empresas"
            value={empresasRaw}
            onChange={(e) => setEmpresasRaw(e.target.value)}
            placeholder="empresa.com, otra.com"
          />
        </div>
        <div className="field">
          <label htmlFor="aut-desconocidos">Tratamiento de datos desconocidos</label>
          <select
            id="aut-desconocidos"
            value={reglas.tratamientoDesconocidos}
            onChange={(e) => set('tratamientoDesconocidos', e.target.value as 'revision' | 'descartar')}
          >
            <option value="revision">Enviar a revisión (bandeja de intervención)</option>
            <option value="descartar">Descartar automáticamente</option>
          </select>
        </div>
        <div className="field check">
          <label>
            <input
              type="checkbox"
              checked={reglas.crearCuentasPortales}
              onChange={(e) => set('crearCuentasPortales', e.target.checked)}
            />{' '}
            Permitir crear cuentas en portales
          </label>
        </div>
        <button type="submit" className="btn" disabled={busy != null}>
          {busy === 'save' ? 'Guardando…' : 'Guardar borrador'}
        </button>
      </form>

      <h2>Autorización escrita</h2>
      <div className="authorize-panel">
        <p>
          <strong>Sin autorización escrita, el modo automático queda bloqueado.</strong> Al firmar, autorizas
          a JOBFORCE a ejecutar la política vigente (versión{' '}
          {state.policy?.version ?? '—'}) según sus reglas y límites. Puedes revocar esta autorización
          en cualquier momento desde esta misma página.
        </p>
        {authError && <div className="error" role="alert">{authError}</div>}
        <form onSubmit={onAuthorize}>
          <div className="field check">
            <label>
              <input
                type="checkbox"
                checked={leido}
                onChange={(e) => setLeido(e.target.checked)}
              />{' '}
              <strong>He leído la política y la autorizo.</strong>
            </label>
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="aut-nombre">Nombre (firma)</label>
              <input
                id="aut-nombre"
                value={autorizadoPor}
                onChange={(e) => setAutorizadoPor(e.target.value)}
                placeholder="Tu nombre"
                maxLength={120}
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="aut-declaracion">Declaración</label>
            <textarea
              id="aut-declaracion"
              rows={3}
              value={declaracion}
              onChange={(e) => setDeclaracion(e.target.value)}
              maxLength={500}
            />
          </div>
          <button type="submit" className="btn" disabled={authBusy}>
            {authBusy ? 'Firmando…' : 'Firmar autorización'}
          </button>
        </form>
      </div>
    </>
  );
}
