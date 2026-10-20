-- 014: canal de aplicación por email.
-- Muchas convocatorias (ONGs, instituciones) no usan portal: se aplica
-- enviando el CV a un correo indicado en el propio anuncio. Se guarda el
-- email extraído del texto de la oferta y la frase que lo acompaña
-- (suele traer el asunto exigido y las instrucciones), para que el
-- asistente pueda ejecutar el envío completo cuando Jon aprueba la
-- candidatura en Revisión.
ALTER TABLE offers ADD COLUMN application_email text;
ALTER TABLE offers ADD COLUMN application_notes text;
