-- Fase 9 — Cuentas en portales de empleo (driver iCIMS).
--
-- La tabla `portal_accounts` existe desde la migración 004 (andamiaje
-- de la Fase 4, nunca usada). Se completa aquí con lo que el esquema
-- de cifrado actual necesita: el nonce AES-GCM separado (como en
-- gmail_tokens/protected_settings) y la marca de último uso.
--
-- Cuando Jon ordena aplicar a una oferta cuyo portal exige cuenta
-- (iCIMS y similares), el ejecutor crea la cuenta con SU correo y una
-- contraseña generada, guardada cifrada para reutilizarla en futuras
-- candidaturas del mismo portal. Autorización de Jon en el chat del
-- Agente (2026-10-21) + regla `crearCuentasPortales` en true.

ALTER TABLE portal_accounts ADD COLUMN IF NOT EXISTS password_nonce text;
ALTER TABLE portal_accounts ADD COLUMN IF NOT EXISTS last_used_at timestamptz;
