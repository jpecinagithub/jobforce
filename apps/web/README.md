# @jobforce/web

Frontend de JOBFORCE (Fase 1): **Next.js 15** (App Router) + **React 19** +
TypeScript. Páginas en español, estilo CSS propio sin dependencias pesadas.

## Páginas

| Ruta             | Contenido                                                     |
|------------------|---------------------------------------------------------------|
| `/login`         | Formulario de acceso (usuario + contraseña).                  |
| `/`              | Inicio: tarjetas de estado (perfil, respuestas, configuración, integraciones) y navegación. |
| `/perfil`        | Versión activa del perfil con hechos agrupados por categoría; lista de versiones con botón "Activar". |
| `/respuestas`    | Lista de respuestas guardadas + formulario de alta.           |
| `/configuracion` | Configuración actual en solo lectura.                         |

El `middleware.ts` redirige a `/login` cuando no existe la cookie de sesión
(`jobforce_session`, nombre tomado de la constante `SESSION_COOKIE_NAME` de
`@jobforce/domain`); se exceptúan `/login` y `/api/*`.

## Cómo habla con el backend

- El **navegador** llama siempre en mismo origen a `/api/*`; `next.config.ts`
  reescribe esas rutas al backend, por lo que **no se necesita CORS**.
- Los **Server Components** llaman al backend directamente por `BACKEND_URL`
  (los rewrites no aplican en servidor) y reenvían la cookie de sesión de la
  petición entrante (`lib/api.ts`, con `cache: 'no-store'`).
- El `csrfToken` devuelto por `POST /api/auth/login` se guarda en memoria
  (contexto React en `lib/auth.tsx`) y se envía como cabecera `x-csrf-token`
  en las operaciones mutadoras; el nombre se toma de la constante
  `CSRF_HEADER_NAME` de `@jobforce/domain`, nunca hardcodeado.

## Variables de entorno

| Variable      | Por defecto              | Descripción                                   |
|---------------|--------------------------|-----------------------------------------------|
| `BACKEND_URL` | `http://127.0.0.1:3001`  | URL base del backend (sin `/api` al final).   |

## Scripts

```bash
pnpm dev        # desarrollo (puerto 3000)
pnpm build      # compilación de producción (next build)
pnpm start      # sirve la compilación
pnpm typecheck  # tsc --noEmit
```

`pnpm build` no requiere que el backend esté arrancado: las páginas son
dinámicas (`force-dynamic`) y muestran un aviso si el backend no responde.
