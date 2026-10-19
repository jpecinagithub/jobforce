import { apiGet } from '@/lib/api';
import ActivateVersionButton from '@/components/ActivateVersionButton';
import FactValue from '@/components/FactValue';
import type { ProfileResponse, ProfileVersion, ProfileFact } from '@jobforce/domain';

export const dynamic = 'force-dynamic';

function groupByCategory(facts: ProfileFact[]): Map<string, ProfileFact[]> {
  const groups = new Map<string, ProfileFact[]>();
  for (const fact of facts) {
    const list = groups.get(fact.category) ?? [];
    list.push(fact);
    groups.set(fact.category, list);
  }
  return groups;
}

export default async function PerfilPage() {
  const [profile, versions] = await Promise.all([
    apiGet<ProfileResponse>('/api/profile'),
    apiGet<ProfileVersion[]>('/api/profile/versions'),
  ]);

  return (
    <>
      <h1>Perfil</h1>

      {!profile.ok && profile.status === 404 && (
        <div className="notice">
          <strong>Aún no hay perfil.</strong>
          <br />
          Crea la primera versión del perfil mediante la API (
          <code>POST /api/profile/versions</code>) para empezar.
        </div>
      )}

      {!profile.ok && profile.status !== 404 && (
        <div className="error" role="alert">{profile.message}</div>
      )}

      {profile.ok && (
        <>
          <p>
            <span className="badge active">versión activa</span>{' '}
            <strong>v{profile.data.version.versionNo}</strong>{' '}
            <span className="muted">
              — {profile.data.facts.length} hechos · fuente: {profile.data.version.source}
            </span>
          </p>

          {profile.data.version.notes && (
            <p className="muted">Notas: {profile.data.version.notes}</p>
          )}

          {profile.data.facts.length === 0 ? (
            <div className="notice">La versión activa no tiene hechos registrados.</div>
          ) : (
            Array.from(groupByCategory(profile.data.facts).entries()).map(([category, facts]) => (
              <section key={category}>
                <h2>{category}</h2>
                <table className="data">
                  <thead>
                    <tr>
                      <th>Clave</th>
                      <th>Valor</th>
                      <th>Fuente</th>
                      <th>Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {facts.map((fact) => (
                      <tr key={`${fact.category}:${fact.key}`}>
                        <td><code>{fact.key}</code></td>
                        <td><FactValue value={fact.value} /></td>
                        <td className="muted">
                          {fact.source}
                          {fact.sourceDetail ? ` · ${fact.sourceDetail}` : ''}
                        </td>
                        <td>
                          <span className="badge">{fact.validationStatus}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            ))
          )}
        </>
      )}

      <h2>Versiones</h2>
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
