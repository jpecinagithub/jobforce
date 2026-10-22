-- 018 — URL real de aplicación de la oferta.
-- offers.url sigue siendo donde se ENCONTRÓ la oferta (la bolsa o el
-- portal). Cuando la oferta viene de una bolsa (The Impact Job,
-- ReliefWeb, LinkedIn…), aplicar ocurre en el portal del empleador:
-- esa URL resuelta se guarda aquí y es la que usan los drivers y la
-- clasificación de portal de la candidatura. NULL = aplicar en url.
ALTER TABLE offers ADD COLUMN IF NOT EXISTS apply_url text;
