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
  paramsText: string;
}

/**
 * Editor de criterios de campaña (contrato §6: PUT /api/campaigns/:id).
 *
 * - Roles como texto separado por comas.
 * - Tabla de requisitos obligatorios: kind + descripción + params como JSON
 *   editable (validado en cliente antes de guardar).
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
      paramsText: JSON.stringify(m.params, null, 2),
    })),
  );
  const [weights, setWeights] = useState<Record<PreferenceKey, string>>(() =>
    Object.fromEntries(
      PREFERENCE_ORDER.map((k) => [k, String(campaign.criteria.preferences[k].weight)]),
    ) as Record<PreferenceKey, string>,
  );
  const [queriesText, setQueriesText] = useState(campaign.criteria.queries.join('\n'));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const weightsSum = useMemo(
    () =>
      PREFERENCE_ORDER.reduce((acc, k) => {
        const w = parseInt(weights[k], 10);
        return acc + (Number.isInteger(w) ? w : 0);
      }, 0),
    [weights],
  );

  function updateRow(i: number, patch: Partial<MandatoryRow>) {
    setMandatory((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  function removeRow(i: number) {
    setMandatory((rows) => rows.filter((_, j) => j !== i));
  }

  function addRow() {
    setMandatory((rows) => [
      ...rows,
      { id: `req${rows.length + 1}`, kind: 'keyword' as MandatoryKind, description: '', paramsText: '{\n  "any_of": []\n}' },
    ]);
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

    // Validación de la tabla de obligatorios (incluido el JSON de params).
    const seenIds = new Set<string>();
    const mandatoryReqs: MandatoryRequirement[] = [];
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
      let params: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(row.paramsText.trim() === '' ? '{}' : row.paramsText);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('no es un objeto');
        }
        params = parsed as Record<string, unknown>;
      } catch {
        fail(`${etiqueta}: «params» no es un JSON válido (debe ser un objeto).`);
        return;
      }
      mandatoryReqs.push({ id, kind: row.kind, description: row.description.trim(), params });
    }

    // Validación de pesos 0..100.
    const prefWeights = {} as Record<PreferenceKey, number>;
    for (const k of PREFERENCE_ORDER) {
      const w = parseInt(weights[k], 10);
      if (!Number.isInteger(w) || w < 0 || w > 100) {
        fail(`El peso de «${PREFERENCE_LABELS[k]}» debe ser un entero entre 0 y 100.`);
        return;
      }
      prefWeights[k] = w;
    }

    const queries = queriesText.split('\n').map((q) => q.trim()).filter(Boolean);
    if (queries.length > 5) {
      fail('Máximo 5 consultas (el backend usa las 5 primeras como mucho).');
      return;
    }

    const criteria: CampaignCriteria = {
      roles,
      mandatory: mandatoryReqs,
      preferences: Object.fromEntries(
        PREFERENCE_ORDER.map((k) => [
          k,
          { ...campaign.criteria.preferences[k], weight: prefWeights[k] },
        ]),
      ) as CampaignCriteria['preferences'],
      queries,
      unknown_policy: 'conservative',
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
      {mandatory.length === 0 ? (
        <p className="muted">Sin requisitos obligatorios. Añade el primero con el botón de abajo.</p>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Identificador</th>
              <th>Tipo</th>
              <th>Descripción</th>
              <th>Params (JSON)</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {mandatory.map((row, i) => (
              <tr key={i}>
                <td>
                  <input
                    value={row.id}
                    onChange={(e) => updateRow(i, { id: e.target.value })}
                    style={{ width: '7rem' }}
                    aria-label={`Identificador del requisito ${i + 1}`}
                  />
                </td>
                <td>
                  <select
                    value={row.kind}
                    onChange={(e) => updateRow(i, { kind: e.target.value as MandatoryKind })}
                    aria-label={`Tipo del requisito ${i + 1}`}
                  >
                    {MANDATORY_KINDS.map((k) => (
                      <option key={k} value={k}>{MANDATORY_KIND_LABELS[k]}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    value={row.description}
                    onChange={(e) => updateRow(i, { description: e.target.value })}
                    style={{ width: '12rem' }}
                    aria-label={`Descripción del requisito ${i + 1}`}
                  />
                </td>
                <td>
                  <textarea
                    value={row.paramsText}
                    onChange={(e) => updateRow(i, { paramsText: e.target.value })}
                    rows={3}
                    cols={28}
                    spellCheck={false}
                    aria-label={`Params JSON del requisito ${i + 1}`}
                  />
                </td>
                <td>
                  <button type="button" className="btn btn-ghost btn-small" onClick={() => removeRow(i)}>
                    Quitar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button type="button" className="btn btn-ghost btn-small" onClick={addRow} style={{ marginBottom: '1rem' }}>
        Añadir requisito
      </button>

      <h3>Pesos de preferencias (0..100)</h3>
      <table className="data">
        <thead>
          <tr>
            <th>Dimensión</th>
            <th>Peso</th>
            <th>Descripción</th>
          </tr>
        </thead>
        <tbody>
          {PREFERENCE_ORDER.map((k) => (
            <tr key={k}>
              <td><strong>{PREFERENCE_LABELS[k]}</strong></td>
              <td>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={weights[k]}
                  onChange={(e) => setWeights((w) => ({ ...w, [k]: e.target.value }))}
                  style={{ width: '5rem' }}
                  aria-label={`Peso de ${PREFERENCE_LABELS[k]}`}
                />
              </td>
              <td className="muted">
                {campaign.criteria.preferences[k].description}
                <br />
                <small>claves: {campaign.criteria.preferences[k].keywords.join(', ')}</small>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td><strong>Suma</strong></td>
            <td><strong>{weightsSum}</strong></td>
            <td className="muted"><small>la puntuación se normaliza por la suma de pesos</small></td>
          </tr>
        </tfoot>
      </table>

      <div className="field">
        <label htmlFor="ce-queries">Consultas base (una por línea, máx 5; si se deja vacío se generan desde los roles)</label>
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
