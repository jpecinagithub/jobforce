/**
 * @jobforce/connectors — conectores de solo lectura a portales de empleo (Fase 4).
 *
 * Ashby, SmartRecruiters y Workday exponen endpoints públicos (sin API key)
 * con las ofertas de cada empresa. Este paquete ofrece clientes tipados de
 * SOLO LECTURA: descubrir ofertas, leer el detalle, detectar cierres y
 * obtener la URL de aplicación. Ningún conector envía candidaturas
 * automáticamente; el apply siempre ocurre en el portal (o en modo asistido
 * con Playwright, como en la Fase 3 con Personio).
 *
 * La matriz de capacidades probadas vive en `docs/matriz-conectores.md`.
 */

export * from './ashby.js';
export * from './smartrecruiters.js';
export * from './workday.js';
