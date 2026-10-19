#!/usr/bin/env bash
# JOBFORCE · Restauración desde copia cifrada (Fase 5).
#
# Uso:
#   restore.sh <dir-copia> <database-url> [dir-destino-archivos] [identity-key]
#
#   <dir-copia>            directorio de la copia (el que contiene db.dump.age…)
#   <database-url>         URL de la BD destino (debe EXISTIR y estar VACÍA)
#   [dir-destino-archivos] dónde extraer files.tar.gz.age (opcional)
#   [identity-key]         clave privada age (defecto: ~/.config/jobforce/backup-recovery.key)
#
# Pasos: verifica el manifest (sha256) → descifra → pg_restore --no-owner →
# extrae archivos → imprime conteos de verificación.
#
# La BD destino debe estar vacía: pg_restore falla si hay objetos.

set -euo pipefail

COPIA="${1:?uso: restore.sh <dir-copia> <database-url> [dir-destino-archivos] [identity-key]}"
DATABASE_URL_DIR="${2:?uso: restore.sh <dir-copia> <database-url> [dir-destino-archivos] [identity-key]}"
FILES_DEST="${3:-}"
IDENTITY="${4:-$HOME/.config/jobforce/backup-recovery.key}"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }

[[ -d "$COPIA" ]] || { log "ERROR: no existe $COPIA"; exit 1; }
[[ -f "$IDENTITY" ]] || { log "ERROR: no existe la clave $IDENTITY"; exit 1; }
command -v age >/dev/null || { log "ERROR: 'age' no está instalado"; exit 1; }
command -v pg_restore >/dev/null || { log "ERROR: 'pg_restore' no está instalado"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1) Verificar huellas del manifest (si existe).
if [[ -f "$COPIA/manifest.json" ]]; then
  log "verificando manifest.json..."
  python3 - "$COPIA/manifest.json" "$COPIA" <<'EOF'
import hashlib, json, os, sys
man_path, copia = sys.argv[1], sys.argv[2]
man = json.load(open(man_path))
for nombre, esperado in man.get("artefactos", {}).items():
    ruta = os.path.join(copia, nombre)
    if not os.path.exists(ruta):
        print(f"FALTA: {nombre}"); sys.exit(1)
    real = hashlib.sha256(open(ruta, "rb").read()).hexdigest()
    if real != esperado:
        print(f"HUELLA DISTINTA: {nombre}"); sys.exit(1)
    print(f"ok: {nombre}")
EOF
else
  log "sin manifest.json: se omite la verificación de huellas"
fi

# 2) Descifrar el volcado y restaurar.
log "descifrando db.dump.age..."
age --decrypt --identity "$IDENTITY" --output "$TMP/db.dump" "$COPIA/db.dump.age"

log "restaurando en la BD destino (pg_restore --no-owner)..."
pg_restore --no-owner --dbname="$DATABASE_URL_DIR" "$TMP/db.dump"
log "pg_restore completado"

# 3) Archivos (opcional).
if [[ -f "$COPIA/files.tar.gz.age" ]]; then
  DEST="${FILES_DEST:-$TMP/files}"
  mkdir -p "$DEST"
  log "descifrando y extrayendo archivos en $DEST..."
  age --decrypt --identity "$IDENTITY" --output "$TMP/files.tar.gz" "$COPIA/files.tar.gz.age"
  tar -xzf "$TMP/files.tar.gz" -C "$DEST"
  log "archivos extraídos: $(find "$DEST" -type f | wc -l) ficheros"
else
  log "sin files.tar.gz.age: no hay archivos que restaurar"
fi

# 4) Conteos de verificación.
log "conteos en la BD restaurada:"
psql "$DATABASE_URL_DIR" -t -A -c "
SELECT 'campaigns', count(*) FROM campaigns UNION ALL
SELECT 'searches', count(*) FROM searches UNION ALL
SELECT 'offers', count(*) FROM offers UNION ALL
SELECT 'evaluations', count(*) FROM evaluations UNION ALL
SELECT 'cost_events', count(*) FROM cost_events UNION ALL
SELECT 'migraciones', count(*) FROM schema_migrations ORDER BY 1;" 2>/dev/null \
  || log "(aviso: no se pudieron leer los conteos; comprobar manualmente)"

log "restauración completada"
