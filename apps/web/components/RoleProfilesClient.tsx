'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '@/lib/auth';
import { parseApiError } from '@/lib/campaigns';
import ConfirmModal, { type Confirmacion } from '@/components/ConfirmModal';
import type { RoleProfile, RoleProfileFeaturedItem } from '@jobforce/domain';

/**
 * Perfiles por rol: pestañas + tarjetas visuales con edición en la página.
 *
 * La edición trabaja sobre un borrador local; «Guardar» persiste con
 * PUT /api/role-profiles/:id y «Cancelar» descarta sin tocar el servidor.
 * «+ Nuevo perfil» pide solo el nombre del rol y crea un borrador vacío
 * que entra directamente en modo edición.
 */

interface Draft {
  name: string;
  headline: string;
  summary: string;
  featured: RoleProfileFeaturedItem[];
  skillsText: string;
  educationNote: string;
  isDefault: boolean;
}

function draftFrom(p: RoleProfile): Draft {
  return {
    name: p.name,
    headline: p.headline,
    summary: p.summary,
    featured: p.featured.map((f) => ({ ...f })),
    skillsText: p.skills.join(', '),
    educationNote: p.educationNote ?? '',
    isDefault: p.isDefault,
  };
}

function skillsFromText(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export default function RoleProfilesClient({
  initialProfiles,
}: {
  initialProfiles: RoleProfile[];
}) {
  const { mutatingHeaders } = useAuth();
  const [profiles, setProfiles] = useState<RoleProfile[]>(initialProfiles);
  const [activeId, setActiveId] = useState<string | null>(
    () => (initialProfiles.find((p) => p.isDefault) ?? initialProfiles[0])?.id ?? null,
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmacion, setConfirmacion] = useState<Confirmacion | null>(null);

  const active = profiles.find((p) => p.id === activeId) ?? null;

  function selectProfile(id: string) {
    setActiveId(id);
    setEditing(false);
    setDraft(null);
    setError(null);
  }

  function startEdit() {
    if (!active) return;
    setDraft(draftFrom(active));
    setEditing(true);
    setError(null);
    setNotice(null);
  }

  function cancelEdit() {
    setEditing(false);
    setDraft(null);
    setError(null);
  }

  async function saveEdit(e: FormEvent) {
    e.preventDefault();
    if (!active || !draft) return;
    if (draft.name.trim().length === 0) {
      setError('El nombre del rol no puede estar vacío.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const featured = draft.featured
        .map((f) => ({
          title: f.title.trim(),
          subtitle: f.subtitle.trim(),
          description: f.description.trim(),
        }))
        .filter((f) => f.title.length > 0);
      const body = {
        name: draft.name.trim(),
        headline: draft.headline.trim(),
        summary: draft.summary.trim(),
        featured,
        skills: skillsFromText(draft.skillsText),
        educationNote: draft.educationNote.trim() === '' ? null : draft.educationNote.trim(),
        isDefault: draft.isDefault,
      };
      const res = await fetch(`/api/role-profiles/${active.id}`, {
        method: 'PUT',
        headers: mutatingHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(await parseApiError(res));
        return;
      }
      setProfiles((prev) =>
        prev.map((p) =>
          p.id === active.id
            ? {
                ...p,
                name: body.name,
                headline: body.headline,
                summary: body.summary,
                featured: body.featured,
                skills: body.skills,
                educationNote: body.educationNote,
                isDefault: body.isDefault,
              }
            : body.isDefault
              ? { ...p, isDefault: false }
              : p,
        ),
      );
      setEditing(false);
      setDraft(null);
      setNotice('Perfil guardado.');
    } catch {
      setError('No se pudo conectar con el servidor.');
    } finally {
      setBusy(false);
    }
  }

  async function createProfile(e: FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (name.length === 0) {
      setError('Escribe el nombre del rol para crear el perfil.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/role-profiles', {
        method: 'POST',
        headers: mutatingHeaders(),
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        setError(await parseApiError(res));
        return;
      }
      const created = (await res.json()) as RoleProfile;
      setProfiles((prev) => [...prev, created]);
      setActiveId(created.id);
      setCreating(false);
      setNewName('');
      setDraft(draftFrom(created));
      setEditing(true);
      setNotice('Borrador creado: completa el contenido y pulsa Guardar.');
    } catch {
      setError('No se pudo conectar con el servidor.');
    } finally {
      setBusy(false);
    }
  }

  async function deleteProfile() {
    if (!active) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/role-profiles/${active.id}`, {
        method: 'DELETE',
        headers: mutatingHeaders(),
      });
      if (!res.ok) {
        setError(await parseApiError(res));
        return;
      }
      const rest = profiles.filter((p) => p.id !== active.id);
      setProfiles(rest);
      setActiveId((rest.find((p) => p.isDefault) ?? rest[0])?.id ?? null);
      setEditing(false);
      setDraft(null);
      setNotice('Perfil eliminado. Las campañas que lo usaban quedan sin perfil de rol.');
    } catch {
      setError('No se pudo conectar con el servidor.');
    } finally {
      setBusy(false);
    }
  }

  function askDelete() {
    if (!active) return;
    setConfirmacion({
      titulo: 'Eliminar perfil',
      cuerpo: (
        <p>
          Se eliminará el perfil <strong>{active.name}</strong>. Las campañas que lo usan
          quedarán sin perfil de rol (la generación volverá al comportamiento base). El
          perfil base y sus hechos no se tocan.
        </p>
      ),
      textoConfirmar: 'Eliminar',
      onConfirm: () => {
        setConfirmacion(null);
        void deleteProfile();
      },
    });
  }

  function updateFeatured(idx: number, patch: Partial<RoleProfileFeaturedItem>) {
    setDraft((d) =>
      d
        ? {
            ...d,
            featured: d.featured.map((f, i) => (i === idx ? { ...f, ...patch } : f)),
          }
        : d,
    );
  }

  return (
    <>
      <ConfirmModal confirmacion={confirmacion} onClose={() => setConfirmacion(null)} />

      <div className="tabs" role="tablist" aria-label="Perfiles por rol">
        {profiles.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={p.id === activeId}
            className={p.id === activeId ? 'tab active' : 'tab'}
            onClick={() => selectProfile(p.id)}
          >
            {p.name}
            {p.isDefault ? ' · por defecto' : ''}
          </button>
        ))}
        <button
          type="button"
          className="tab new"
          onClick={() => {
            setCreating((c) => !c);
            setError(null);
          }}
        >
          + Nuevo perfil
        </button>
      </div>

      {creating && (
        <form className="form" onSubmit={createProfile} style={{ maxWidth: 520, marginBottom: '1.25rem' }}>
          <div className="field">
            <label htmlFor="rp-new-name">Nombre del rol</label>
            <input
              id="rp-new-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="p. ej. Data Analyst"
              maxLength={120}
              autoFocus
            />
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="submit" className="btn btn-small" disabled={busy}>
              {busy ? 'Creando…' : 'Crear borrador'}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-small"
              onClick={() => setCreating(false)}
              disabled={busy}
            >
              Cancelar
            </button>
          </div>
        </form>
      )}

      {error && <div className="error" role="alert">{error}</div>}
      {notice && <div className="notice" role="status">{notice}</div>}

      {profiles.length === 0 && !creating && (
        <div className="notice">
          Aún no hay perfiles por rol. Crea el primero con «+ Nuevo perfil».
        </div>
      )}

      {active && !editing && (
        <>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0 }}>{active.name}</h2>
            {active.isDefault && <span className="badge active">por defecto</span>}
            <span style={{ flex: 1 }} />
            <button type="button" className="btn btn-small" onClick={startEdit}>
              Editar
            </button>
            <button type="button" className="btn btn-ghost btn-small" onClick={askDelete}>
              Eliminar
            </button>
          </div>

          <div className="profile-cards">
            <section className="card">
              <p className="section-label">Titular</p>
              <p style={{ fontSize: '1.15rem', fontWeight: 700, margin: 0 }}>
                {active.headline || <span className="muted">Sin titular todavía. Pulsa Editar para escribirlo.</span>}
              </p>
            </section>

            <section className="card">
              <p className="section-label">Resumen</p>
              <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                {active.summary || <span className="muted">Sin resumen todavía.</span>}
              </p>
            </section>

            <section className="card">
              <p className="section-label">Experiencia / proyectos destacados</p>
              {active.featured.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>Sin bloques destacados todavía.</p>
              ) : (
                active.featured.map((f, i) => (
                  <div className="featured-item" key={i}>
                    <div className="ftitle">{f.title}</div>
                    {f.subtitle && <div className="fsub">{f.subtitle}</div>}
                    {f.description && <div className="fdesc">{f.description}</div>}
                  </div>
                ))
              )}
            </section>

            <section className="card">
              <p className="section-label">Habilidades clave</p>
              {active.skills.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>Sin habilidades todavía.</p>
              ) : (
                <div className="chips">
                  {active.skills.map((s) => (
                    <span className="chip" key={s}>{s}</span>
                  ))}
                </div>
              )}
            </section>

            {active.educationNote && (
              <section className="card">
                <p className="section-label">Formación</p>
                <p style={{ margin: 0 }}>{active.educationNote}</p>
              </section>
            )}
          </div>
        </>
      )}

      {active && editing && draft && (
        <form className="form" onSubmit={saveEdit} style={{ maxWidth: 760 }}>
          <div className="field">
            <label htmlFor="rp-name">Nombre del rol</label>
            <input
              id="rp-name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              maxLength={120}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="rp-headline">Titular</label>
            <input
              id="rp-headline"
              value={draft.headline}
              onChange={(e) => setDraft({ ...draft, headline: e.target.value })}
              maxLength={300}
              placeholder="p. ej. Finance Manager / CFO · 15+ años · IFRS"
            />
          </div>
          <div className="field">
            <label htmlFor="rp-summary">Resumen</label>
            <textarea
              id="rp-summary"
              value={draft.summary}
              onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
              maxLength={5000}
              rows={5}
            />
          </div>

          <fieldset style={{ border: '1px solid var(--border)', borderRadius: 12, padding: '1rem' }}>
            <legend className="section-label" style={{ padding: '0 0.4rem' }}>
              Experiencia / proyectos destacados
            </legend>
            {draft.featured.map((f, i) => (
              <div key={i} style={{ marginBottom: '1rem' }}>
                <div className="field">
                  <label htmlFor={`rp-f-title-${i}`}>Título</label>
                  <input
                    id={`rp-f-title-${i}`}
                    value={f.title}
                    onChange={(e) => updateFeatured(i, { title: e.target.value })}
                    maxLength={200}
                    placeholder="p. ej. CFO — SurExport Peru Berries SAC"
                  />
                </div>
                <div className="field">
                  <label htmlFor={`rp-f-sub-${i}`}>Subtítulo (lugar · fechas)</label>
                  <input
                    id={`rp-f-sub-${i}`}
                    value={f.subtitle}
                    onChange={(e) => updateFeatured(i, { subtitle: e.target.value })}
                    maxLength={200}
                    placeholder="p. ej. Lima, Perú · 2023 – 2026"
                  />
                </div>
                <div className="field">
                  <label htmlFor={`rp-f-desc-${i}`}>Descripción</label>
                  <textarea
                    id={`rp-f-desc-${i}`}
                    value={f.description}
                    onChange={(e) => updateFeatured(i, { description: e.target.value })}
                    maxLength={1500}
                    rows={2}
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  onClick={() =>
                    setDraft({ ...draft, featured: draft.featured.filter((_, j) => j !== i) })
                  }
                >
                  Quitar bloque
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn btn-ghost btn-small"
              onClick={() =>
                setDraft({
                  ...draft,
                  featured: [...draft.featured, { title: '', subtitle: '', description: '' }],
                })
              }
            >
              + Añadir bloque
            </button>
          </fieldset>

          <div className="field">
            <label htmlFor="rp-skills">Habilidades clave (separadas por comas)</label>
            <input
              id="rp-skills"
              value={draft.skillsText}
              onChange={(e) => setDraft({ ...draft, skillsText: e.target.value })}
              placeholder="IFRS, SAP, Oracle, Power BI"
            />
          </div>
          <div className="field">
            <label htmlFor="rp-education">Formación (nota)</label>
            <input
              id="rp-education"
              value={draft.educationNote}
              onChange={(e) => setDraft({ ...draft, educationNote: e.target.value })}
              maxLength={1500}
              placeholder="p. ej. Ingeniero Industrial — Universidad de Navarra"
            />
          </div>
          <div className="field">
            <label>
              <input
                type="checkbox"
                checked={draft.isDefault}
                onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })}
              />{' '}
              Usar como perfil por defecto en las campañas nuevas
            </label>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="submit" className="btn" disabled={busy}>
              {busy ? 'Guardando…' : 'Guardar'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={cancelEdit} disabled={busy}>
              Cancelar
            </button>
          </div>
        </form>
      )}
    </>
  );
}
