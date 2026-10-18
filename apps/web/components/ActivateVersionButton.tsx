'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';

export default function ActivateVersionButton({ versionId }: { versionId: string }) {
  const router = useRouter();
  const { mutatingHeaders } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onActivate() {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/profile/versions/${versionId}/activate`, {
        method: 'POST',
        headers: mutatingHeaders(),
      });
      if (!res.ok) {
        setError(`No se pudo activar la versión (${res.status}).`);
        return;
      }
      router.refresh();
    } catch {
      setError('No se pudo conectar con el servidor.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button type="button" className="btn btn-small" onClick={onActivate} disabled={loading}>
        {loading ? 'Activando…' : 'Activar'}
      </button>
      {error && <div className="error" role="alert" style={{ marginTop: '0.5rem' }}>{error}</div>}
    </>
  );
}
