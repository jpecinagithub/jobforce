'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import type { LoginRequest, LoginResponse } from '@jobforce/domain';

export default function LoginPage() {
  const router = useRouter();
  const { setSession } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const body: LoginRequest = { username, password };
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        if (res.status === 401) {
          setError('Usuario o contraseña incorrectos.');
        } else {
          setError(`El servidor respondió con un error (${res.status}). Inténtalo de nuevo.`);
        }
        return;
      }
      const data = (await res.json()) as LoginResponse;
      setSession(data.username, data.csrfToken);
      router.push('/');
      router.refresh();
    } catch {
      setError('No se pudo conectar con el servidor. Comprueba que el backend está arrancado.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <h1>Iniciar sesión</h1>
      <p className="muted">Accede a tu instancia privada de JOBFORCE.</p>
      {error && <div className="error" role="alert">{error}</div>}
      <form className="form" onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="username">Usuario</label>
          <input
            id="username"
            name="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password">Contraseña</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <button type="submit" className="btn" disabled={loading}>
          {loading ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </>
  );
}
