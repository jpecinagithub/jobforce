import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthProvider } from '@/lib/auth';
import LogoutButton from '@/components/LogoutButton';
import './globals.css';

export const metadata: Metadata = {
  title: 'JOBFORCE',
  description: 'Asistente privado de búsqueda de empleo',
};

const NAV = [
  { href: '/', label: 'Inicio' },
  { href: '/perfil', label: 'Perfil' },
  { href: '/campanas', label: 'Campañas' },
  { href: '/revision', label: 'Revisión' },
  { href: '/respuestas', label: 'Respuestas' },
  { href: '/autonomia', label: 'Autonomía' },
  { href: '/intervenciones', label: 'Intervenciones' },
  { href: '/cambios', label: 'Cambios' },
  { href: '/etiquetas', label: 'Etiquetas' },
  { href: '/configuracion', label: 'Configuración' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>
        <AuthProvider>
          <header className="topbar">
            <span className="brand">JOBFORCE</span>
            <nav>
              {NAV.map((item) => (
                <Link key={item.href} href={item.href}>
                  {item.label}
                </Link>
              ))}
            </nav>
            <LogoutButton />
          </header>
          <main className="container">{children}</main>
        </AuthProvider>
      </body>
    </html>
  );
}
