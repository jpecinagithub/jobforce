-- 007_fase5_gmail.sql — Fase 5: OAuth de Gmail en el producto.
--
-- - gmail_oauth_states: estados anti-CSRF del flujo OAuth (un solo uso,
--   con caducidad). Se consumen en el callback.
-- - gmail_tokens: tokens de Google por proveedor (UNIQUE provider). El
--   refresh_token se guarda SIEMPRE cifrado (refresh_token_ciphertext +
--   refresh_token_nonce + key_ref); jamás en claro.
-- - protected_settings: ajustes protegidos editables desde el panel
--   (p. ej. google_client_id / google_client_secret). Valores SIEMPRE
--   cifrados; la lectura pública nunca devuelve el secreto.

CREATE TABLE gmail_oauth_states (
  state text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX idx_gmail_oauth_states_expires ON gmail_oauth_states (expires_at);

CREATE TABLE gmail_tokens (
  provider text PRIMARY KEY CHECK (provider IN ('google')),
  refresh_token_ciphertext text NOT NULL,
  refresh_token_nonce text NOT NULL,
  key_ref text NOT NULL,
  account_email text,
  scope text,
  obtained_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE protected_settings (
  clave text PRIMARY KEY CHECK (clave IN ('google_client_id', 'google_client_secret')),
  value_ciphertext text NOT NULL,
  value_nonce text NOT NULL,
  key_ref text NOT NULL,
  updated_by uuid REFERENCES admin_users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
