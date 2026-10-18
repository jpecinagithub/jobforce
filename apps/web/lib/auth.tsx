/**
 * Contexto de autenticación (cliente).
 *
 * El csrfToken devuelto por POST /api/auth/login se guarda en memoria
 * (estado React) y se adjunta como cabecera x-csrf-token en las
 * operaciones mutadoras. Las peticiones mutadoras se hacen en mismo
 * origen a /api/*, de modo que la cookie de sesión viaja automáticamente.
 */
'use client';

import { createContext, useCallback, useContext, useState } from 'react';
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

  const setSession = useCallback((user: string, token: string) => {
    setUsername(user);
    setCsrfToken(token);
  }, []);

  const clearSession = useCallback(() => {
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
