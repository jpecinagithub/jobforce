-- 011: calidad de búsqueda — validación de enlaces de ofertas.
ALTER TABLE offers ADD COLUMN url_ok boolean;
ALTER TABLE offers ADD COLUMN url_checked_at timestamptz;
