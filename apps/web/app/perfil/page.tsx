import { apiGet } from '@/lib/api';
import ActivateVersionButton from '@/components/ActivateVersionButton';
import RoleProfilesClient from '@/components/RoleProfilesClient';
import type { ProfileResponse, ProfileVersion, ProfileFact, RoleProfile } from '@jobforce/domain';

export const dynamic = 'force-dynamic';

/**
 * Página de Perfil (fase «Perfiles por rol»).
 *
 * Lo que Jon ve y edita aquí es el CONTENIDO: la persona (cabecera leída de
 * los hechos verificados) y sus perfiles por rol como tarjetas visuales.
 * La tabla clave-valor de hechos ya no se presenta: los hechos quedan como
 * fuente interna de la máquina (versión activa y su activación, al pie).
 *
 * PRIVACIDAD: la cabecera se construye con una LISTA BLANCA de hechos
 * (nombre, ubicación, idiomas, disponibilidad). El hecho `phone`
 * (highly_sensitive) nunca se lee ni se pinta en esta página.
 */

function asObj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asStr(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

interface PersonHead {
  name: string | null;
  location: string | null;
  languages: string[];
  availability: string | null;
  initials: string;
}

function personFromFacts(facts: ProfileFact[]): PersonHead {
  const get = (category: string, key: string) =>
    facts.find((f) => f.category === category && f.key === key)?.value;

  const name = asStr(get('identity', 'full_name'));

  const locRaw = get('identity', 'location');
  const locObj = asObj(locRaw);
  const location = locObj
    ? [asStr(locObj.city), asStr(locObj.country)].filter(Boolean).join(', ')
    : asStr(locRaw);

  const languages = facts
    .filter((f) => f.category === 'languages')
    .map((f) => {
      const o = asObj(f.value);
      if (o) {
        const lang = asStr(o.language);
        const level = asStr(o.level);
        return [lang ? cap(lang) : null, level].filter(Boolean).join(' · ');
      }
      return asStr(f.value) ?? '';
    })
    .filter((s) => s.length > 0);

  // Disponibilidad: solo si existe un hecho que la declare (la v1 no trae
  // ninguno; no se inventa). Se busca por clave/categoría, nunca el teléfono.
  const availFact = facts.find(
    (f) => /availab|disponib/i.test(f.key) || /availab|disponib/i.test(f.category),
  );
  let availability: string | null = null;
  if (availFact) {
    availability = asStr(availFact.value) ?? asStr(asObj(availFact.value)?.text ?? null);
  }

  const initials = (name ?? 'J P')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('');

  return { name, location, languages, availability, initials };
}

export default async function PerfilPage() {
  const [profile, versions, roleProfiles] = await Promise.all([
    apiGet<ProfileResponse>('/api/profile'),
    apiGet<ProfileVersion[]>('/api/profile/versions'),
    apiGet<RoleProfile[]>('/api/role-profiles'),
  ]);

  const person = profile.ok ? personFromFacts(profile.data.facts) : null;

  return (
    <>
      <h1>Perfil</h1>

      {!profile.ok && profile.status === 404 && (
        <div className="notice">
          <strong>Aún no hay perfil base.</strong>
          <br />
          Crea la primera versión del perfil mediante la API (
          <code>POST /api/profile/versions</code>) para empezar. Los perfiles por
          rol de abajo ya se pueden preparar.
        </div>
      )}
      {!profile.ok && profile.status !== 404 && (
        <div className="error" role="alert">{profile.message}</div>
      )}

      {person && (
        <div className="card person-head">
          <div className="avatar" aria-hidden="true">{person.initials}</div>
          <div>
            <p className="pname">{person.name ?? 'Sin nombre en el perfil'}</p>
            <p className="psub">
              {[
                person.location,
                person.languages.length > 0 ? person.languages.join(' · ') : null,
                person.availability ? `Disponibilidad: ${person.availability}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
        </div>
      )}

      <h2>Perfiles por rol</h2>
      <p className="muted" style={{ maxWidth: 720 }}>
        La misma persona, contada para cada tipo de puesto. Cada campaña usa el
        perfil que elijas: el CV y la carta abrirán con su titular, su resumen
        y sus habilidades. El perfil base (hechos verificados) no cambia.
      </p>

      {!roleProfiles.ok ? (
        <div className="error" role="alert">{roleProfiles.message}</div>
      ) : (
        <RoleProfilesClient initialProfiles={roleProfiles.data} />
      )}

      <h2 style={{ marginTop: '2.5rem' }}>Datos verificados (base)</h2>
      {profile.ok && (
        <p className="muted">
          <span className="badge active">versión activa</span>{' '}
          <strong>v{profile.data.version.versionNo}</strong> — {profile.data.facts.length}{' '}
          hechos · fuente: {profile.data.version.source}
          {profile.data.version.notes ? ` · Notas: ${profile.data.version.notes}` : ''}
        </p>
      )}
      {!versions.ok ? (
        <div className="error" role="alert">{versions.message}</div>
      ) : versions.data.length === 0 ? (
        <p className="muted">No hay versiones de perfil registradas.</p>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Versión</th>
              <th>Estado</th>
              <th>Fuente</th>
              <th>Creada</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {versions.data.map((v) => (
              <tr key={v.id}>
                <td><strong>v{v.versionNo}</strong></td>
                <td>
                  <span className={v.status === 'active' ? 'badge active' : 'badge'}>
                    {v.status}
                  </span>
                </td>
                <td className="muted">{v.source}</td>
                <td className="muted">{new Date(v.createdAt).toLocaleString('es-ES')}</td>
                <td>
                  {v.status !== 'active' && <ActivateVersionButton versionId={v.id} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
