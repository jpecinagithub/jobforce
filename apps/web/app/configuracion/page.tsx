import { apiGet } from '@/lib/api';
import GoogleOAuthSection from '@/components/GoogleOAuthSection';
import type { ConfigurationVersion } from '@jobforce/domain';

export const dynamic = 'force-dynamic';

export default async function ConfiguracionPage() {
  const config = await apiGet<ConfigurationVersion>('/api/config');

  return (
    <>
      <h1>Configuración</h1>
      <p className="muted">Versión actual de la configuración (solo lectura).</p>

      {!config.ok ? (
        config.status === 404 ? (
          <div className="notice">
            Aún no hay ninguna versión de configuración guardada. Se creará automáticamente al
            publicar el primer cambio desde la página Cambios.
          </div>
        ) : (
          <div className="error" role="alert">{config.message}</div>
        )
      ) : (
        <>
          <p>
            <strong>Versión {config.data.versionNo}</strong>{' '}
            <span className="muted">
              — creada el {new Date(config.data.createdAt).toLocaleString('es-ES')}
              {config.data.note ? ` · ${config.data.note}` : ''}
            </span>
          </p>
          <pre className="json">{JSON.stringify(config.data.config, null, 2)}</pre>
        </>
      )}

      <GoogleOAuthSection />
    </>
  );
}
