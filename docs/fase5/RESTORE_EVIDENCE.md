# Evidencia de restauración — Fase 5 (19-oct-2026)

Restauración **completa y verificada** de una copia cifrada de producción en
un entorno limpio (PostgreSQL 16 local en la VM del agente, BD
`jobforce_restore` creada vacía para la prueba).

## Cadena ejercitada (extremo a extremo)

1. `infra/backup/backup.sh` ejecutado **en Oracle** (manual, 14:20 UTC) con el
   mismo código que corre el cron diario → copia `20261019-142024` en
   `/home/ubuntu/backups/jobforce/`, artefactos cifrados con age (clave
   pública de `infra/backup/recipient.txt`).
2. Artefactos descargados a la VM del agente.
3. `infra/backup/verify.sh` → huellas sha256 del manifest OK, descifrado OK,
   `pg_restore --list` lee el volcado (48 tablas).
4. `infra/backup/restore.sh` → verifica manifest, descifra con la clave
   privada de recuperación, `pg_restore --no-owner` en BD vacía.

## Verificación de integridad

Conteos producción (Oracle, `jobforce-postgres-1`) vs BD restaurada:

| tabla             | producción | restaurada |
|-------------------|------------|------------|
| campaigns         | 2          | 2          |
| searches          | 6          | 6          |
| offers            | 24         | 24         |
| evaluations       | 24         | 24         |
| campaign_reports  | 1          | 1          |
| audit_events      | 3          | 3          |
| autonomy_policies | 1          | 1          |

Checksums md5 (agregado ordenado por id) — **idénticos** en ambos lados:

| datos       | md5                              |
|-------------|----------------------------------|
| offers      | `8400121c5ca92b5d93850e40bde80dbd` |
| evaluations | `1e175718ee87f810122762bf74be5a13` |
| searches    | `ccb2a021b0884c987ad0a9be2ad662b9` |

Prueba adicional: sobre la BD restaurada (migraciones 001–005) se ejecutó el
runner de migraciones → la **006_fase5_costes se aplicó limpiamente**
(`budget_config` con 2 filas, `cost_events` y `connector_breakers` creadas).
La copia restaurada es, por tanto, un punto de partida válido para seguir
operando.

## Programación

Cron del usuario `ubuntu` en Oracle (instalado 19-oct-2026, verificado con
`crontab -l`):

```
0 3 * * * /home/ubuntu/jobforce-backup/backup.sh >> /home/ubuntu/jobforce-backup/backup.log 2>&1
```

Retención: 7 días. RPO: 24 h (pérdida máxima de datos).

## Clave de recuperación

Par age generado el 19-oct-2026. La **privada** está en
`~/.config/jobforce/backup-recovery.key` (600) en la VM del agente — Jon debe
custodiar una copia fuera de estas máquinas. La **pública** vive en
`infra/backup/recipient.txt` (no es secreta).
