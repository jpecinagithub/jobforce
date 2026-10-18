'use client';

import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';

export default function LogoutButton() {
  const router = useRouter();
  const { clearSession, mutatingHeaders } = useAuth();

  async function onLogout() {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: mutatingHeaders(),
      });
    } catch {
      /* aunque falle la petición, se cierra la sesión local */
    }
    clearSession();
    router.push('/login');
    router.refresh();
  }

  return (
    <button type="button" className="btn btn-ghost" onClick={onLogout}>
      Salir
    </button>
  );
}
