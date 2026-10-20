'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { defaultCriteria } from '@jobforce/domain';
import type { RoleProfile } from '@jobforce/domain';
import { parseApiError } from '@/lib/campaigns';

/**
 * Formulario "Nueva campaña" (contrato §6: POST /api/campaigns).
 * Los criterios se inicializan con defaultCriteria() de @jobforce/domain.
 * El selector «Perfil» elige el perfil por rol de la campaña (el marcado
 * «por defecto» viene preseleccionado); «Sin perfil específico» envía null.
 */
export default function NewCampaignForm() {
  const router = useRouter();
  const { mutatingHeaders } = useAuth();
  const [name, setName] = useState('');
  const [budgetCap, setBudgetCap] = useState('3.00');
  const [profiles, setProfiles] = useState<RoleProfile[] | null>(null);
  const [roleId, setRoleId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/role-profiles');
        if (!res.ok) return;
        const list = (await res.json()) as RoleProfile[];
        if (cancelled) return;
        setProfiles(list);
        const preselect = list.find((p) => p.isDefault) ?? list[0];
        if (preselect) setRoleId(preselect.id);
      } catch {
        // Sin perfiles cargados el selector queda deshabilitado y la campaña
        // se crea sin perfil explícito (el backend asigna el por defecto).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 120) {
      setError('El nombre debe tener entre 1 y 120 caracteres.');
      return;
    }
    const cap = parseFloat(budgetCap.replace(',', '.'));
    if (!Number.isFinite(cap) || cap <= 0 || cap > 100) {
      setError('El límite de presupuesto debe ser un número entre 0 y 100 USD.');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/campaigns', {
        method: 'POST',
        headers: mutatingHeaders(),
        body: JSON.stringify({
          name: trimmed,
          criteria: defaultCriteria(),
          exa_budget_cap_usd: cap,
          role_profile_id: roleId === '' ? null : roleId,
        }),
      });
      if (!res.ok) {
        setError(await parseApiError(res));
        return;
      }
      setName('');
      setBudgetCap('3.00');
      router.refresh();
    } catch {
      setError('No se pudo conectar con el servidor.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="form" onSubmit={onSubmit} style={{ maxWidth: 640 }}>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="field">
        <label htmlFor="nc-name">Nombre</label>
        <input
          id="nc-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="p. ej. Búsqueda CFO Q1 2027"
          maxLength={120}
          required
        />
      </div>
      <div className="field">
        <label htmlFor="nc-budget">Límite de presupuesto Exa (USD)</label>
        <input
          id="nc-budget"
          value={budgetCap}
          onChange={(e) => setBudgetCap(e.target.value)}
          inputMode="decimal"
        />
        <p className="muted" style={{ marginTop: '0.35rem' }}>
          La campaña se crea con los criterios por defecto del perfil; podrás
          editarlos en su página de detalle.
        </p>
      </div>
      <div className="field">
        <label htmlFor="nc-profile">Perfil</label>
        <select
          id="nc-profile"
          value={roleId}
          onChange={(e) => setRoleId(e.target.value)}
          disabled={profiles === null}
        >
          <option value="">Sin perfil específico</option>
          {(profiles ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.isDefault ? ' (por defecto)' : ''}
            </option>
          ))}
        </select>
        <p className="muted" style={{ marginTop: '0.35rem' }}>
          El CV y la carta de las candidaturas de esta campaña abrirán con el
          titular, el resumen y las habilidades de este perfil.
        </p>
      </div>
      <button type="submit" className="btn" disabled={loading}>
        {loading ? 'Creando…' : 'Crear campaña'}
      </button>
    </form>
  );
}
