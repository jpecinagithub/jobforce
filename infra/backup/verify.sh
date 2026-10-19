#!/usr/bin/env bash
# JOBFORCE · Verificación de una copia cifrada sin restaurar (Fase 5).
#
# Uso: verify.sh <dir-copia> [identity-key]
#
# Comprueba: huellas sha256 del manifest, descifrado íntegro de cada
# artefacto (a un temporal) y que el volcado es un pg_dump válido
# (`pg_restore --list` lo puede leer).

set -euo pipefail

COPIA="${1:?uso: verify.sh <dir-copia> [identity-key]}"
IDENTITY="${2:-$HOME/.config/jobforce/backup-recovery.key}"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }

[[ -d "$COPIA" ]] || { log "ERROR: no existe $COPIA"; exit 1; }
[[ -f "$IDENTITY" ]] || { log "ERROR: no existe la clave $IDENTITY"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

python3 - "$COPIA/manifest.json" "$COPIA" <<'EOF'
import hashlib, json, os, sys
man = json.load(open(sys.argv[1])); copia = sys.argv[2]
for nombre, esperado in man.get("artefactos", {}).items():
    ruta = os.path.join(copia, nombre)
    assert os.path.exists(ruta), f"FALTA {nombre}"
    real = hashlib.sha256(open(ruta, "rb").read()).hexdigest()
    assert real == esperado, f"HUELLA DISTINTA {nombre}"
    print(f"huella ok: {nombre}")
print(f"copia: {man.get('copia')}  generada_en: {man.get('generada_en')}")
EOF

log "descifrando artefactos..."
for art in db.dump state.json files.tar.gz; do
  [[ -f "$COPIA/$art.age" ]] || { log "  (sin $art.age, se omite)"; continue; }
  age --decrypt --identity "$IDENTITY" --output "$TMP/$art" "$COPIA/$art.age"
  log "  descifrado ok: $art ($(du -h "$TMP/$art" | cut -f1))"
done

log "validando el volcado con pg_restore --list..."
pg_restore --list "$TMP/db.dump" > "$TMP/toc.txt"
tablas=$(grep -c "^.*;.* TABLE " "$TMP/toc.txt" || true)
log "  el volcado contiene $tablas tablas: OK"
log "verificación completada"
