'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { defaultCriteria } from '@jobforce/domain';
import { parseApiError } from '@/lib/campaigns';

/**
 * Formulario "Nueva campaña" (contrato §6: POST /api/campaigns).
 * Los criterios se inicializan con defaultCriteria() de @jobforce/domain.
 */
export default function NewCampaignForm() {
  const router = useRouter();
  const { mutatingHeaders } = useAuth();
  const [name, setName] = useState('');
  const [budgetCap, setBudgetCap] = useState('3.00');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
      <button type="submit" className="btn" disabled={loading}>
        {loading ? 'Creando…' : 'Crear campaña'}
      </button>
    </form>
  );
}
