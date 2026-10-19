# Copias de seguridad cifradas de JOBFORCE (Fase 5)

## Qué se respalda (diario, 03:00 UTC en Oracle)

1. **PostgreSQL**: `pg_dump -Fc` de la BD `jobforce` → `db.dump.age`.
2. **Archivos versionados**: `~/workspace/jobforce` (documentos, capturas de
   envíos) → `files.tar.gz.age` (se omite si aún no existe el directorio).
3. **Estado de ejecución**: `state.json` con conteos por tabla y migraciones
   aplicadas → `state.json.age`.
4. **Manifest**: `manifest.json` (sin cifrar) con el sha256 de cada artefacto
   cifrado, para verificar integridad sin descifrar.

Todo se cifra con **age** usando la clave **pública** de `recipient.txt`.
La clave **privada** de recuperación la custodia Jon en
`~/.config/jobforce/backup-recovery.key` (permisos 600) y **nunca** está en
el servidor ni en el repo.

- Destino en Oracle: `/home/ubuntu/backups/jobforce/<AAAAMMDD-HHMMSS>/`
- Retención: 7 días (las copias más antiguas se purgan solas).
- Objetivo: pérdida máxima de datos de 24 h (RPO 24 h).

## Dónde está programado

Cron del usuario `ubuntu` en Oracle (instalado 19-oct-2026):

```
0 3 * * * /home/ubuntu/jobforce-backup/backup.sh >> /home/ubuntu/jobforce-backup/backup.log 2>&1
```

Ver con: `crontab -l`. Los scripts canónicos viven en `infra/backup/` del
repo; la copia ejecutada por el cron está en `/home/ubuntu/jobforce-backup/`
(se sincroniza en cada despliegue).

## Restauración (demostrada 19-oct-2026)

```
./restore.sh <dir-copia> <database-url-destino> [dir-destino-archivos] [clave-privada]
```

La BD destino debe existir y estar vacía. El script verifica el manifest,
descifra, hace `pg_restore --no-owner`, extrae los archivos e imprime los
conteos de verificación.

Evidencia de la restauración de prueba: `docs/fase5/RESTORE_EVIDENCE.md`.

## Verificación sin restaurar

```
./verify.sh <dir-copia> [clave-privada]
```

## Rotación de la clave

1. Generar un par nuevo con `age-keygen`.
2. Guardar la privada en `~/.config/jobforce/backup-recovery.key` (600).
3. Sustituir `infra/backup/recipient.txt` por la pública y redesplegar.
4. Las copias antiguas siguen necesitando la clave anterior: consérvala.
