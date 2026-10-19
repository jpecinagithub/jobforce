import Link from 'next/link';
import { apiGet } from '@/lib/api';
import type { ProfileResponse, AnswerMemory, ConfigurationVersion } from '@jobforce/domain';

export const dynamic = 'force-dynamic';

interface AnswerRecord extends AnswerMemory {
  id?: string;
}

export default async function HomePage() {
  const [profile, answers, config] = await Promise.all([
    apiGet<ProfileResponse>('/api/profile'),
    apiGet<AnswerRecord[]>('/api/answers'),
    apiGet<ConfigurationVersion>('/api/config'),
  ]);

  const factsCount = profile.ok ? profile.data.facts.length : null;
  const answersCount = answers.ok ? answers.data.length : null;
  const configOk = config.ok;

  return (
    <>
      <h1>Inicio</h1>
      <p className="muted">Estado general de tu instancia de JOBFORCE.</p>

      <div className="cards">
        <div className="card">
          <div className="label">Perfil — hechos de la versión activa</div>
          <div className="big">{factsCount ?? '—'}</div>
          {!profile.ok && profile.status === 404 ? (
            <span className="muted">Aún no hay perfil.</span>
          ) : (
            <Link href="/perfil">Ver perfil</Link>
          )}
        </div>

        <div className="card">
          <div className="label">Respuestas guardadas</div>
          <div className="big">{answersCount ?? '—'}</div>
          <Link href="/respuestas">Gestionar respuestas</Link>
        </div>

        <div className="card">
          <div className="label">Configuración</div>
          <div className="big">{configOk ? '✓' : '—'}</div>
          <Link href="/configuracion">Ver configuración</Link>
        </div>

        <div className="card">
          <div className="label">Integraciones</div>
          <div className="big">
            <span className="badge pending">configurable</span>
          </div>
          <span className="muted">Conecta Gmail con OAuth desde la configuración.</span>
          <br />
          <Link href="/configuracion">Configurar Gmail</Link>
        </div>
      </div>

      {(!profile.ok && profile.status !== 404) && (
        <div className="notice" style={{ marginTop: '1.5rem' }}>
          No se pudo cargar el estado del perfil: {profile.message}
        </div>
      )}
      {!answers.ok && (
        <div className="notice" style={{ marginTop: '1.5rem' }}>
          No se pudieron cargar las respuestas: {answers.message}
        </div>
      )}
      {(!configOk && config.status !== 404) && (
        <div className="notice" style={{ marginTop: '1.5rem' }}>
          No se pudo cargar la configuración: {config.message}
        </div>
      )}
      {!configOk && config.status === 404 && (
        <div className="notice" style={{ marginTop: '1.5rem' }}>
          Aún no hay ninguna versión de configuración guardada (se creará al publicar el primer cambio desde /cambios).
        </div>
      )}
    </>
  );
}
