'use client';

import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import type {
  Campaign,
  CampaignCriteria,
  MandatoryKind,
  MandatoryRequirement,
  PreferenceKey,
} from '@jobforce/domain';
import {
  MANDATORY_KINDS,
  MANDATORY_KIND_LABELS,
  PREFERENCE_LABELS,
  PREFERENCE_ORDER,
  STATUS_LABELS,
  parseApiError,
  type CampaignStatus,
} from '@/lib/campaigns';

interface Props {
  campaign: Campaign;
}

interface MandatoryRow {
  id: string;
  kind: MandatoryKind;
  description: string;
  params: Record<string, unknown>;
}

/** Idiomas ofrecidos como casillas en el requisito de idioma. */
const LANGUAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'english', label: 'Inglés' },
  { value: 'spanish', label: 'Castellano' },
  { value: 'french', label: 'Francés' },
  { value: 'portuguese', label: 'Portugués' },
  { value: 'german', label: 'Alemán' },
  { value: 'italian', label: 'Italiano' },
  { value: 'dutch', label: 'Neerlandés' },
];

const LOCATION_MODES: Array<{ value: string; label: string }> = [
  { value: 'any', label: 'Cualquiera (remoto o presencial)' },
  { value: 'onsite', label: 'Presencial' },
  { value: 'remote_ok', label: 'Remoto o presencial' },
];

function strList(params: Record<string, unknown>, key: string): string[] {
  const v = params[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Params por defecto al crear un requisito o cambiar su tipo. */
function defaultParams(kind: MandatoryKind): Record<string, unknown> {
  switch (kind) {
    case 'role':
      return { roles: [] };
    case 'language':
      return { languages: [] };
    case 'location':
      return { mode: 'any', countries: [] };
    case 'seniority':
      return { levels: [] };
    case 'keyword':
      return { any_of: [] };
  }
}

/**
 * Editor de listas por etiquetas: cada valor es una pastilla quitable y
 * se añaden escribiendo + Enter (o con el botón). Sustituye al JSON en
 * crudo de los params, que era inmanejable para listas de textos.
 */
function ChipsEditor({
  label,
  hint,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  hint?: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');
  function add() {
    const v = draft.trim().replace(/,$/, '');
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft('');
  }
  return (
    <div className="field" style={{ marginBottom: '0.5rem' }}>
      <label>{label}</label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginBottom: '0.35rem' }}>
        {values.length === 0 ? (
          <span className="muted">— ninguno todavía —</span>
        ) : (
          values.map((v) => (
            <span
              key={v}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.3rem',
                padding: '0.15rem 0.5rem',
                border: '1px solid var(--border, #444)',
                borderRadius: '999px',
                fontSize: '0.85rem',
              }}
            >
              {v}
              <button
                type="button"
                aria-label={`Quitar ${v}`}
                onClick={() => onChange(values.filter((x) => x !== v))}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: '0.9rem', lineHeight: 1 }}
              >
                ×
              </button>
            </span>
          ))
        )}
      </div>
      <div style={{ display: 'flex', gap: '0.4rem' }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add();
            }
          }}
          placeholder={placeholder}
          style={{ flex: 1 }}
        />
        <button type="button" className="btn btn-ghost btn-small" onClick={add}>
          Añadir
        </button>
      </div>
      {hint ? <small className="muted">{hint}</small> : null}
    </div>
  );
}

/** Campos de params según el tipo de requisito, sin JSON a la vista. */
function ParamsEditor({
  row,
  onParams,
}: {
  row: MandatoryRow;
  onParams: (params: Record<string, unknown>) => void;
}) {
  const p = row.params;
  const set = (patch: Record<string, unknown>) => onParams({ ...p, ...patch });
  switch (row.kind) {
    case 'role':
      return (
        <ChipsEditor
          label="Roles aceptados"
          values={strList(p, 'roles')}
          onChange={(v) => set({ roles: v })}
          placeholder="finance manager"
          hint="El título de la oferta debe nombrar uno de estos roles (tal como aparecen en los anuncios, normalmente en inglés)."
        />
      );
    case 'seniority':
      return (
        <ChipsEditor
          label="Niveles aceptados"
          values={strList(p, 'levels')}
          onChange={(v) => set({ levels: v })}
          placeholder="senior"
          hint="Niveles de antigüedad que cumplen (p. ej. senior, manager, director)."
        />
      );
    case 'keyword':
      return (
        <>
          <ChipsEditor
            label="Debe aparecer alguna de estas frases"
            values={strList(p, 'any_of')}
            onChange={(v) => set({ any_of: v })}
            placeholder="médicos sin fronteras"
            hint="Vale con que el anuncio contenga una sola de la lista."
          />
          <ChipsEditor
            label="Excluir si aparece alguna de estas (opcional)"
            values={strList(p, 'none_of')}
            onChange={(v) => {
              const next: Record<string, unknown> = { ...p, none_of: v };
              if (v.length === 0) delete next['none_of'];
              onParams(next);
            }}
            placeholder="prácticas"
          />
        </>
      );
    case 'location':
      return (
        <>
          <div className="field" style={{ marginBottom: '0.5rem' }}>
            <label>Modalidad</label>
            <select
              value={typeof p.mode === 'string' ? p.mode : 'any'}
              onChange={(e) => set({ mode: e.target.value })}
            >
              {LOCATION_MODES.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
          <ChipsEditor
            label="Países o regiones aceptados"
            values={strList(p, 'countries')}
            onChange={(v) => set({ countries: v })}
            placeholder="kenya"
            hint="En inglés y en minúsculas, como salen en los anuncios (kenya, senegal, latin america…)."
          />
        </>
      );
    case 'language': {
      const selected = strList(p, 'languages');
      const known = LANGUAGE_OPTIONS.map((o) => o.value);
      const extra = selected.filter((v) => !known.includes(v));
      const toggle = (value: string, on: boolean) =>
        set({ languages: on ? [...selected, value] : selected.filter((x) => x !== value) });
      return (
        <div className="field" style={{ marginBottom: '0.5rem' }}>
          <label>Idiomas de trabajo aceptados (vale cualquiera)</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem' }}>
            {LANGUAGE_OPTIONS.map((o) => (
              <label key={o.value} style={{ display: 'inline-flex', gap: '0.3rem', alignItems: 'center', fontWeight: 'normal' }}>
                <input
                  type="checkbox"
                  checked={selected.includes(o.value)}
                  onChange={(e) => toggle(o.value, e.target.checked)}
                />
                {o.label}
              </label>
            ))}
            {extra.map((v) => (
              <span key={v} style={{ display: 'inline-flex', gap: '0.3rem', alignItems: 'center' }}>
                {v}
                <button
                  type="button"
                  aria-label={`Quitar ${v}`}
                  onClick={() => toggle(v, false)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      );
    }
  }
}

/**
 * Editor de criterios de campaña (contrato §6: PUT /api/campaigns/:id).
 *
 * - Roles como texto separado por comas.
 * - Requisitos obligatorios: una tarjeta por requisito con campos
 *   estructurados según el tipo (etiquetas, casillas, selectores) — sin
 *   JSON a la vista (cambio pedido por Jon el 20-oct-2026).
 * - Pesos de preferencias 0..100 (entero) por dimensión, con suma visible.
 * - Consultas editables, una por línea (máx 5, como el contrato).
 * - Límite de presupuesto USD (>0, ≤100).
 */
export default function CriteriaEditor({ campaign }: Props) {
  const router = useRouter();
  const { mutatingHeaders } = useAuth();

  const [name, setName] = useState(campaign.name);
  const [status, setStatus] = useState<CampaignStatus>(campaign.status);
  const [budgetCap, setBudgetCap] = useState(String(campaign.exa_budget_cap_usd));
  const [rolesText, setRolesText] = useState(campaign.criteria.roles.join(', '));
  const [mandatory, setMandatory] = useState<MandatoryRow[]>(() =>
    campaign.criteria.mandatory.map((m) => ({
      id: m.id,
      kind: m.kind,
      description: m.description,
      params: m.params,
    })),
  );
  const [prefs, setPrefs] = useState<
    Record<PreferenceKey, { weight: string; description: string; keywords: string[] }>
  >(() =>
    Object.fromEntries(
      PREFERENCE_ORDER.map((k) => [
        k,
        {
          weight: String(campaign.criteria.preferences[k].weight),
          description: campaign.criteria.preferences[k].description,
          keywords: [...campaign.criteria.preferences[k].keywords],
        },
      ]),
    ) as Record<PreferenceKey, { weight: string; description: string; keywords: string[] }>,
  );
  const [queriesText, setQueriesText] = useState(campaign.criteria.queries.join('\n'));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const weightsSum = useMemo(
    () =>
      PREFERENCE_ORDER.reduce((acc, k) => {
        const w = parseInt(prefs[k].weight, 10);
        return acc + (Number.isInteger(w) ? w : 0);
      }, 0),
    [prefs],
  );

  function updatePref(k: PreferenceKey, patch: Partial<{ weight: string; description: string; keywords: string[] }>) {
    setPrefs((p) => ({ ...p, [k]: { ...p[k], ...patch } }));
  }

  function updateRow(i: number, patch: Partial<MandatoryRow>) {
    setMandatory((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  function removeRow(i: number) {
    setMandatory((rows) => rows.filter((_, j) => j !== i));
  }

  function addRow() {
    setMandatory((rows) => [
      ...rows,
      { id: `req${rows.length + 1}`, kind: 'keyword' as MandatoryKind, description: '', params: defaultParams('keyword') },
    ]);
  }

  /** Al cambiar el tipo, si faltan las claves de ese tipo se siembran. */
  function changeKind(i: number, kind: MandatoryKind) {
    setMandatory((rows) =>
      rows.map((r, j) => {
        if (j !== i) return r;
        const seed = defaultParams(kind);
        const merged = { ...seed, ...r.params };
        // Para la clave principal del nuevo tipo manda lo sembrado si la
        // fila no la traía del tipo anterior.
        return { ...r, kind, params: merged };
      }),
    );
  }

  function fail(message: string) {
    setError(message);
    setSaved(null);
    setLoading(false);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(null);

    const trimmedName = name.trim();
    if (trimmedName.length === 0 || trimmedName.length > 120) {
      fail('El nombre debe tener entre 1 y 120 caracteres.');
      return;
    }
    const cap = parseFloat(budgetCap.replace(',', '.'));
    if (!Number.isFinite(cap) || cap <= 0 || cap > 100) {
      fail('El límite de presupuesto debe ser un número entre 0 y 100 USD.');
      return;
    }
    const roles = rolesText.split(',').map((r) => r.trim()).filter(Boolean);

    // Validación de los obligatorios: cada tipo exige su lista principal.
    const seenIds = new Set<string>();
    const mandatoryReqs: MandatoryRequirement[] = [];
    const REQUIRED_LIST: Record<MandatoryKind, { key: string; label: string }> = {
      role: { key: 'roles', label: 'al menos un rol aceptado' },
      language: { key: 'languages', label: 'al menos un idioma aceptado' },
      location: { key: 'countries', label: 'al menos un país o región' },
      seniority: { key: 'levels', label: 'al menos un nivel aceptado' },
      keyword: { key: 'any_of', label: 'al menos una frase' },
    };
    for (let i = 0; i < mandatory.length; i++) {
      const row = mandatory[i];
      const etiqueta = `Requisito ${i + 1}`;
      const id = row.id.trim();
      if (!id) {
        fail(`${etiqueta}: el identificador es obligatorio.`);
        return;
      }
      if (seenIds.has(id)) {
        fail(`${etiqueta}: identificador duplicado («${id}»).`);
        return;
      }
      seenIds.add(id);
      if (!row.description.trim()) {
        fail(`${etiqueta}: la descripción es obligatoria.`);
        return;
      }
      const req = REQUIRED_LIST[row.kind];
      if (strList(row.params, req.key).length === 0) {
        fail(`${etiqueta} («${id}»): falta ${req.label}.`);
        return;
      }
      mandatoryReqs.push({ id, kind: row.kind, description: row.description.trim(), params: row.params });
    }

    // Validación de preferencias: peso 0..100 y descripción no vacía.
    const prefDims = {} as CampaignCriteria['preferences'];
    for (const k of PREFERENCE_ORDER) {
      const w = parseInt(prefs[k].weight, 10);
      if (!Number.isInteger(w) || w < 0 || w > 100) {
        fail(`El peso de «${PREFERENCE_LABELS[k]}» debe ser un entero entre 0 y 100.`);
        return;
      }
      if (!prefs[k].description.trim()) {
        fail(`La descripción de «${PREFERENCE_LABELS[k]}» es obligatoria.`);
        return;
      }
      prefDims[k] = {
        weight: w,
        description: prefs[k].description.trim(),
        keywords: prefs[k].keywords,
      };
    }

    const queries = queriesText.split('\n').map((q) => q.trim()).filter(Boolean);
    if (queries.length > 10) {
      fail('Máximo 10 consultas (el backend usa 5 al día en rotación).');
      return;
    }

    const criteria: CampaignCriteria = {
      roles,
      mandatory: mandatoryReqs,
      preferences: prefDims,
      queries,
      unknown_policy: 'conservative',
      // Los dominios de búsqueda no se editan en este formulario: se
      // conservan tal cual (sin esto, guardar borraría el filtro).
      ...(campaign.criteria.include_domains
        ? { include_domains: campaign.criteria.include_domains }
        : {}),
    };

    setLoading(true);
    try {
      const res = await fetch(`/api/campaigns/${encodeURIComponent(campaign.id)}`, {
        method: 'PUT',
        headers: mutatingHeaders(),
        body: JSON.stringify({
          name: trimmedName,
          criteria,
          exa_budget_cap_usd: cap,
          status,
        }),
      });
      if (!res.ok) {
        fail(await parseApiError(res));
        return;
      }
      setSaved('Criterios guardados correctamente.');
      router.refresh();
    } catch {
      fail('No se pudo conectar con el servidor.');
      return;
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} style={{ maxWidth: 720 }}>
      {error && <div className="error" role="alert">{error}</div>}
      {saved && <div className="notice" role="status">{saved}</div>}

      <div className="field">
        <label htmlFor="ce-name">Nombre</label>
        <input id="ce-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
      </div>

      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
        <div className="field" style={{ flex: '1 1 200px' }}>
          <label htmlFor="ce-status">Estado</label>
          <select id="ce-status" value={status} onChange={(e) => setStatus(e.target.value as CampaignStatus)}>
            {(Object.keys(STATUS_LABELS) as CampaignStatus[]).map((s) => (
              <option key={s} value={s}>{STATUS_LABELS[s]}</option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flex: '1 1 200px' }}>
          <label htmlFor="ce-budget">Límite de presupuesto Exa (USD)</label>
          <input id="ce-budget" value={budgetCap} onChange={(e) => setBudgetCap(e.target.value)} inputMode="decimal" />
        </div>
      </div>

      <div className="field">
        <label htmlFor="ce-roles">Roles (separados por comas)</label>
        <input
          id="ce-roles"
          value={rolesText}
          onChange={(e) => setRolesText(e.target.value)}
          placeholder="CFO, Finance Manager, Controller"
        />
      </div>

      <h3>Requisitos obligatorios</h3>
      <p className="muted" style={{ marginTop: '-0.5rem' }}>
        Una oferta debe cumplirlos todos para pasar el filtro. Cada requisito se edita con
        campos normales según su tipo — sin código.
      </p>
      {mandatory.length === 0 ? (
        <p className="muted">Sin requisitos obligatorios. Añade el primero con el botón de abajo.</p>
      ) : (
        mandatory.map((row, i) => (
          <fieldset
            key={i}
            style={{
              border: '1px solid var(--border, #333)',
              borderRadius: '8px',
              padding: '0.75rem 1rem 0.5rem',
              marginBottom: '0.75rem',
            }}
          >
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'end' }}>
              <div className="field" style={{ marginBottom: '0.5rem' }}>
                <label>Identificador</label>
                <input
                  value={row.id}
                  onChange={(e) => updateRow(i, { id: e.target.value })}
                  style={{ width: '9rem' }}
                  aria-label={`Identificador del requisito ${i + 1}`}
                />
              </div>
              <div className="field" style={{ marginBottom: '0.5rem' }}>
                <label>Tipo</label>
                <select
                  value={row.kind}
                  onChange={(e) => changeKind(i, e.target.value as MandatoryKind)}
                  aria-label={`Tipo del requisito ${i + 1}`}
                >
                  {MANDATORY_KINDS.map((k) => (
                    <option key={k} value={k}>{MANDATORY_KIND_LABELS[k]}</option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ flex: '1 1 220px', marginBottom: '0.5rem' }}>
                <label>Descripción</label>
                <input
                  value={row.description}
                  onChange={(e) => updateRow(i, { description: e.target.value })}
                  aria-label={`Descripción del requisito ${i + 1}`}
                />
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-small"
                onClick={() => removeRow(i)}
                style={{ marginBottom: '0.5rem' }}
              >
                Quitar
              </button>
            </div>
            <ParamsEditor row={row} onParams={(params) => updateRow(i, { params })} />
          </fieldset>
        ))
      )}
      <button type="button" className="btn btn-ghost btn-small" onClick={addRow} style={{ marginBottom: '1rem' }}>
        Añadir requisito
      </button>

      <h3>Preferencias puntuables</h3>
      <p className="muted" style={{ marginTop: '-0.5rem' }}>
        Cada dimensión suma hasta su peso cuando el anuncio contiene sus palabras clave.
        La nota final se normaliza por la suma de pesos (ahora <strong>{weightsSum}</strong>).
        Edita la descripción y las claves a tu gusto — antes solo se veían.
      </p>
      {PREFERENCE_ORDER.map((k) => (
        <fieldset
          key={k}
          style={{
            border: '1px solid var(--border, #333)',
            borderRadius: '8px',
            padding: '0.75rem 1rem 0.5rem',
            marginBottom: '0.75rem',
          }}
        >
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'end' }}>
            <strong style={{ marginBottom: '0.5rem', minWidth: '7rem' }}>{PREFERENCE_LABELS[k]}</strong>
            <div className="field" style={{ marginBottom: '0.5rem' }}>
              <label>Peso (0..100)</label>
              <input
                type="number"
                min={0}
                max={100}
                value={prefs[k].weight}
                onChange={(e) => updatePref(k, { weight: e.target.value })}
                style={{ width: '5rem' }}
                aria-label={`Peso de ${PREFERENCE_LABELS[k]}`}
              />
            </div>
            <div className="field" style={{ flex: '1 1 260px', marginBottom: '0.5rem' }}>
              <label>Descripción</label>
              <input
                value={prefs[k].description}
                onChange={(e) => updatePref(k, { description: e.target.value })}
                aria-label={`Descripción de ${PREFERENCE_LABELS[k]}`}
              />
            </div>
          </div>
          <ChipsEditor
            label="Palabras clave que suman en esta dimensión"
            values={prefs[k].keywords}
            onChange={(v) => updatePref(k, { keywords: v })}
            placeholder="contabilidad"
            hint="Si el anuncio contiene alguna, la dimensión puntúa en proporción a cuántas aparecen."
          />
        </fieldset>
      ))}

      <div className="field">
        <label htmlFor="ce-queries">Consultas base (una por línea, máx 10: cada día se usan 5 en rotación; si se deja vacío se generan desde los roles)</label>
        <textarea
          id="ce-queries"
          rows={4}
          value={queriesText}
          onChange={(e) => setQueriesText(e.target.value)}
          placeholder={'CFO remote finance\nFinance Manager Spain'}
        />
      </div>

      <button type="submit" className="btn" disabled={loading}>
        {loading ? 'Guardando…' : 'Guardar criterios'}
      </button>
    </form>
  );
}
