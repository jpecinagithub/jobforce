-- Columna DESTINO de la tabla de ofertas (petición de Jon, 2026-10-21):
-- lugar de trabajo extraído con evidencia literal del texto del anuncio
-- (campos Country:/City: de ReliefWeb, etiqueta Location:, sufijo del
-- título). NULL = no consta («—» en la tabla), nunca un lugar inventado.

ALTER TABLE offers ADD COLUMN IF NOT EXISTS location text;
