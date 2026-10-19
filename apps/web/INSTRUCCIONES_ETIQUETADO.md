# Instrucciones de etiquetado (para Jon)

La página **/etiquetas** sirve para construir el *dataset etiquetado*: tu criterio
humano sobre ofertas y correos. Con él medimos la precisión real del sistema
(¿acierta al decir qué encaja y al clasificar los correos?). Sin tus etiquetas
no hay medida posible.

## Cómo etiquetar ofertas

Cada fila muestra empresa, puesto, score y la predicción del sistema
(score ≥ 70 ⇒ «encaja»). Etiqueta con **un toque**:

- **Sí encaja**: la enviarías tú mismo tras leer la oferta. Es una oferta que
  merece la pena de verdad.
- **No encaja**: la descartarías de verdad (sector, nivel, ubicación,
  condiciones… lo que sea, tu criterio manda).

Puedes añadir una nota opcional (p. ej. «buen salario pero sin teletrabajo»).
Si cambias de opinión, vuelve a pulsar: la última etiqueta es la que vale.

**Consejo**: decide primero con tu criterio y mira la predicción del sistema
después. Así la medida es honesta.

## Cómo etiquetar correos

Cada fila muestra asunto, remitente, fecha y la clasificación que predijo el
seguimiento. Elige en el desplegable lo que el mensaje **realmente** es:

- **Confirmación**: la empresa confirma algo (recepción de candidatura,
  confirmación de entrevista ya cerrada, acuse de recibo…).
- **Rechazo**: te descartan del proceso, con o sin explicaciones.
- **Entrevista**: te invitan a una entrevista o a la siguiente fase.
- **Ambiguo**: no se puede decidir qué es (mensaje confuso, plantilla genérica).
- **Otro**: cualquier otra cosa (spam, newsletters, duplicados…).

De nuevo: decide tú primero; la predicción del sistema está para comparar,
no para copiar.

## Cómo leer el informe de precisión (pestaña «Precisión»)

Se calcula **solo** con tus etiquetas frente a las predicciones. La confianza
que declara el modelo no cuenta para nada.

**Encaje de ofertas**

- **Precisión**: de las ofertas que el sistema dijo que encajaban, ¿qué
  fracción encajaba de verdad? (1.0 = nunca se equivoca al decir «sí»).
- **Recall**: de las ofertas que encajaban de verdad, ¿qué fracción detectó el
  sistema? (1.0 = no se le escapa ninguna buena).
- Debajo verás los conteos: aciertos (dijo sí y era sí / dijo no y era no) y
  errores (dijo sí y era no / dijo no y era sí). Con pocas etiquetas los
  números bailan; a partir de unas 20–30 etiquetas empiezan a ser fiables.

**Clasificación de correos**

- **Exactitud**: fracción de correos donde la predicción del sistema coincide
  con tu etiqueta.
- **Matriz de confusión**: lista de pares `predicha__real` con su cuenta
  (p. ej. `rechazo__entrevista: 2` = dos veces predijo rechazo y era
  entrevista). Sirve para ver *dónde* se equivoca el sistema.

Si el informe dice «Sin etiquetas todavía», es que aún no hay etiquetas en
esa pestaña: etiqueta primero y vuelve.
