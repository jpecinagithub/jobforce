-- 005_sender.sql — Ejecutor de envíos: nuevo tipo de intervención 'error_tecnico'.
--
-- El ejecutor necesita una categoría honesta para errores técnicos
-- inesperados ANTES de pulsar Submit (caída de red a mitad del rellenado,
-- el navegador no arranca, la subida no completa, etc.): nada se envió, así
-- que no es 'envio_incierto' (contrato: enviado pero sin confirmación), ni
-- encaja en las otras cuatro categorías. 'error_tecnico' lo describe sin
-- maquillaje y lleva a la bandeja con el contexto del fallo.

DO $$
DECLARE
  cname text;
BEGIN
  SELECT conname INTO cname
    FROM pg_constraint
   WHERE conrelid = 'interventions'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%datos_desconocidos%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE interventions DROP CONSTRAINT %I', cname);
  END IF;
END
$$;

ALTER TABLE interventions
  ADD CONSTRAINT interventions_kind_check
  CHECK (kind IN (
    'datos_desconocidos','pregunta_ambigua','captcha_mfa',
    'fuera_de_politica','envio_incierto','error_tecnico'
  ));
