#!/usr/bin/env bash
# JOBFORCE · Copia de seguridad diaria cifrada (Fase 5).
#
# Qué hace:
#   1. pg_dump (formato custom, comprimido) de la BD `jobforce` del contenedor
#      `jobforce-postgres-1`.
#   2. Tar comprimido de los archivos versionados (`~/workspace/jobforce`:
#      documentos, capturas de envíos), si el directorio existe.
#   3. `state.json` con el estado de ejecución: conteos por tabla y
#      migraciones aplicadas.
#   4. Cifra cada artefacto con `age` usando la clave PÚBLICA de
#      `recipient.txt` (la clave privada de recuperación NUNCA está en el
#      servidor: la custodia Jon).
#   5. Genera `manifest.json` (sha256 de cada artefacto cifrado) y purga las
#      copias con más de RETENTION_DAYS días.
#
# Instalación (en Oracle): ver README.md — cron diario 03:00.
#
# Variables (todas opcionales):
#   BACKUP_DIR      destino (defecto: $HOME/backups/jobforce)
#   RETENTION_DAYS  días a conservar (defecto: 7)
#   PG_CONTAINER    contenedor postgres (defecto: jobforce-postgres-1)
#   PG_USER / PG_DB (defecto: jobforce / jobforce)
#   FILES_DIR       archivos a respaldar (defecto: $HOME/workspace/jobforce)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/jobforce}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
PG_CONTAINER="${PG_CONTAINER:-jobforce-postgres-1}"
PG_USER="${PG_USER:-jobforce}"
PG_DB="${PG_DB:-jobforce}"
FILES_DIR="${FILES_DIR:-$HOME/workspace/jobforce}"
RECIPIENT_FILE="${RECIPIENT_FILE:-$SCRIPT_DIR/recipient.txt}"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }

command -v age >/dev/null || { log "ERROR: 'age' no está instalado"; exit 1; }
command -v docker >/dev/null || { log "ERROR: 'docker' no está instalado"; exit 1; }
[[ -f "$RECIPIENT_FILE" ]] || { log "ERROR: no existe $RECIPIENT_FILE"; exit 1; }

STAMP="$(date -u '+%Y%m%d-%H%M%S')"
DAY_DIR="$BACKUP_DIR/$STAMP"
mkdir -p "$DAY_DIR"
log "copia $STAMP → $DAY_DIR"

# 1) Volcado de PostgreSQL (formato custom -Fc, compresión nivel 6).
log "pg_dump de $PG_DB..."
docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" -Fc -Z6 \
  > "$DAY_DIR/db.dump"
log "db.dump: $(du -h "$DAY_DIR/db.dump" | cut -f1)"

# 2) Archivos versionados (documentos, capturas). Se omite si no existe aún.
if [[ -d "$FILES_DIR" ]]; then
  log "empaquetando $FILES_DIR..."
  tar -czf "$DAY_DIR/files.tar.gz" -C "$(dirname "$FILES_DIR")" "$(basename "$FILES_DIR")"
  log "files.tar.gz: $(du -h "$DAY_DIR/files.tar.gz" | cut -f1)"
else
  log "sin directorio de archivos ($FILES_DIR): se omite files.tar.gz"
fi

# 3) Estado de ejecución: conteos por tabla + migraciones aplicadas.
log "generando state.json..."
TABLES="campaigns searches offers evaluations campaign_reports sends interventions autonomy_policies documents applications audit_events cost_events connector_breakers"
{
  echo '{'
  echo "  \"generada_en\": \"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\","
  echo '  "tablas": {'
  first=1
  for t in $TABLES; do
    n="$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -t -A -c "SELECT count(*) FROM \"$t\";" 2>/dev/null || echo '?')"
    [[ $first -eq 0 ]] && echo ','
    printf '    "%s": %s' "$t" "$n"
    first=0
  done
  echo ''
  echo '  },'
  migs="$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -t -A -c "SELECT string_agg(version, ',' ORDER BY version) FROM schema_migrations;" 2>/dev/null || echo '?')"
  echo "  \"migraciones\": \"$migs\""
  echo '}'
} > "$DAY_DIR/state.json"

# 4) Cifrado con age (solo la clave pública está en el servidor).
for f in "$DAY_DIR"/db.dump "$DAY_DIR"/files.tar.gz "$DAY_DIR"/state.json; do
  [[ -f "$f" ]] || continue
  age -R "$RECIPIENT_FILE" --output "$f.age" "$f"
  sha256sum "$f.age" | awk -v n="$(basename "$f").age" '{print "    \"" n "\": \"" $1 "\""}' >> "$DAY_DIR/.manifest_entries"
  shred -u "$f" 2>/dev/null || rm -f "$f"
done

# 5) Manifest con huellas sha256 de los artefactos cifrados.
{
  echo '{'
  echo "  \"copia\": \"$STAMP\","
  echo "  \"generada_en\": \"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\","
  echo '  "artefactos": {'
  paste -sd ',' "$DAY_DIR/.manifest_entries"
  echo ''
  echo '  }'
  echo '}'
} > "$DAY_DIR/manifest.json"
rm -f "$DAY_DIR/.manifest_entries"
log "manifest.json generado"

# 6) Purga: conservar solo los últimos RETENTION_DAYS días.
log "purgando copias con más de $RETENTION_DAYS días..."
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime "+$((RETENTION_DAYS - 1))" -print -exec rm -rf {} + || true

quedan="$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d | wc -l)"
log "copia $STAMP completada. Copias conservadas: $quedan"
