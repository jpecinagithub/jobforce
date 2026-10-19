/**
 * Contexto de autenticación (cliente).
 *
 * El csrfToken devuelto por POST /api/auth/login se guarda en memoria
 * (estado React) y se adjunta como cabecera x-csrf-token en las
 * operaciones mutadoras. Las peticiones mutadoras se hacen en mismo
 * origen a /api/*, de modo que la cookie de sesión viaja automáticamente.
 */
'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CSRF_HEADER_NAME } from '@jobforce/domain';

interface AuthState {
  csrfToken: string | null;
  username: string | null;
  setSession: (username: string, csrfToken: string) => void;
  clearSession: () => void;
  /** Cabeceras para operaciones mutadoras (incluye x-csrf-token). */
  mutatingHeaders: () => Record<string, string>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const hasSession = useRef(false);

  const setSession = useCallback((user: string, token: string) => {
    hasSession.current = true;
    try {
      sessionStorage.setItem('jobforce_csrf', token);
      sessionStorage.setItem('jobforce_user', user);
    } catch {
      /* almacenamiento no disponible: se sigue solo en memoria */
    }
    setUsername(user);
    setCsrfToken(token);
  }, []);

  // Restaura la sesión tras recargas o pestañas nuevas: el token CSRF vive
  // en memoria y se pierde al recargar. Primero se intenta sessionStorage
  // (misma pestaña); si no hay, /api/auth/me lo devuelve para la sesión
  // de la cookie (requiere backend con el fix).
  useEffect(() => {
    if (hasSession.current) return;
    try {
      const t = sessionStorage.getItem('jobforce_csrf');
      if (t) {
        setSession(sessionStorage.getItem('jobforce_user') ?? '', t);
        return;
      }
    } catch {
      /* sin sessionStorage: se intenta /me */
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/auth/me');
        if (!res.ok) return;
        const data = (await res.json()) as { username?: string; csrfToken?: string };
        if (!cancelled && !hasSession.current && data?.csrfToken) {
          setSession(data.username ?? '', data.csrfToken);
        }
      } catch {
        /* sin sesión válida: se queda como invitado */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setSession]);

  const clearSession = useCallback(() => {
    hasSession.current = false;
    try {
      sessionStorage.removeItem('jobforce_csrf');
      sessionStorage.removeItem('jobforce_user');
    } catch {
      /* nada que limpiar */
    }
    setUsername(null);
    setCsrfToken(null);
  }, []);

  const mutatingHeaders = useCallback(
    (): Record<string, string> => ({
      'Content-Type': 'application/json',
      ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
    }),
    [csrfToken],
  );

  return (
    <AuthContext.Provider value={{ csrfToken, username, setSession, clearSession, mutatingHeaders }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth debe usarse dentro de <AuthProvider>');
  return ctx;
}
