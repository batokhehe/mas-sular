# Mas Sular — Backup & Disaster Recovery Runbook (PostgreSQL)

**Audience:** any engineer with shell + Docker access. No prior context assumed.
**Last validated:** production-readiness H1 — `scripts/backup/test-backup-restore.sh`
(27 checks, throwaway PostgreSQL 16 migrated with the real migrations), local Docker.
The MySQL-era procedures this runbook used to describe (Phase 5J.13) no longer apply:
the application database is PostgreSQL 16.

Every procedure below carries a status label. Read it before relying on the step:

| Label | Meaning |
|---|---|
| **VERIFIED** | Executed and independently checked by the automated test above |
| **AVAILABLE, NOT PRODUCTION-VERIFIED** | Mechanism works; never exercised at production scale or on the VPS |
| **MANUAL ACTION REQUIRED** | A human must do this; no automation exists |
| **NOT IMPLEMENTED** | Does not exist. Do not assume it protects you. |

---

## 1. Purpose

**Protects:** the PostgreSQL application database and the customer uploads volume
(product images, payment receipts) — the only two data classes that cannot be
reconstructed from source control or by restarting a service.

**Restores:** those two data classes into an isolated target, verified before use.

**Applies to:** the Dockerised Mas Sular stack defined by `docker-compose.production.yml`.

**What this is NOT:**
- **Not point-in-time recovery.** Each backup is a logical snapshot (`pg_dump`). There
  is no WAL archiving. A restore returns the data as it was at the chosen backup and
  **loses every write made after it**. RPO = time since the last successful backup.
- Not off-server by itself — copying artifacts off the VPS is a separate step (§16).
- Not a key-escrow system (§17).

---

## 2. System recovery model

| Component | Class | Backup? | Restore? | Rebuild? | Depends on |
|---|---|---|---|---|---|
| **PostgreSQL** | **CRITICAL** | Yes | Yes | No | — |
| **Uploads volume** (`mas-sular_uploads_data`) | **CRITICAL** | Yes | Yes | No | — |
| **Redis** | EPHEMERAL | **No** | **No** | Yes — recreate empty | — |
| **RabbitMQ** | REBUILDABLE | **No** | **No** | Yes — topology re-asserted on consumer boot | PostgreSQL (`OutboxEvent` is authoritative) |
| **Backend / Frontend / Admin** | REBUILDABLE | No | No | Build from the release commit | Backend: PostgreSQL, migrations, Redis, RabbitMQ |
| **Secrets / config** (`production.env`, backup key) | **CRITICAL** | **Yes — separately** | Yes | No | Must exist before anything starts |

- Redis runs with `save ""` / `appendonly no` and holds cache only.
- RabbitMQ topology is recreated by `assertExchange`/`assertQueue` at consumer start.
  **`OutboxEvent` rows in PostgreSQL are the authoritative record** — the relay
  republishes anything unsent, and consumers deduplicate via `ProcessedEvent`.

---

## 3. Backup artifact layout

**The key must never live inside the backup directory** — the script refuses to run if it does.

```
<BACKUP_DIR>/                                   # e.g. /srv/backups/mas-sular  (outside any git checkout)
  mas-sular-postgres-YYYYMMDD-HHMMSSZ.dump.enc  # pg_dump custom format (-Fc), GPG AES-256
  mas-sular-uploads-YYYYMMDD-HHMMSSZ.tar.gz.enc # tar of the uploads volume, GPG AES-256
  manifest-YYYYMMDD-HHMMSSZ.json

<KEY_DIR>/                                      # e.g. /etc/mas-sular — root-only, NOT in BACKUP_DIR
  backup.key
```

- Timestamps are **UTC**, `Z`-suffixed; both artifacts of one run share it.
- The **encrypted artifact is the canonical copy**. Plaintext exists only in a temp
  work dir during the run and is deleted on every exit path.
- Manifest (safe metadata only — no credentials, no PII, no SQL):

```json
{
  "timestamp": "...", "label": "scheduled | pre-migrate | ...", "database": "mas_sular",
  "postgres": { "artifact": "...", "format": "pg_dump custom (-Fc)", "tables_with_data": 0,
                "sha256": "...", "size": 0, "plaintext_sha256": "..." },
  "uploads":  { "artifact": "...", "files": 0, "sha256": "...", "size": 0, "plaintext_sha256": "..." },
  "encryption": { "tool": "gpg", "algorithm": "AES-256", "integrity": "OpenPGP MDC (verified by decrypt round-trip)" },
  "point_in_time_recovery": false
}
```

---

## 4. Backup procedure — **VERIFIED** (locally; see header)

Script: **`scripts/backup/backup.sh`**, run from the repository root on the VPS.

**One-time key setup — MANUAL ACTION REQUIRED:**
```bash
sudo install -d -m 700 /etc/mas-sular
sudo sh -c 'head -c 48 /dev/urandom | base64 > /etc/mas-sular/backup.key && chmod 600 /etc/mas-sular/backup.key'
sudo install -d -m 700 /srv/backups/mas-sular
```
Then escrow a copy of the key OFF the VPS (§17) **before** the first real backup.

**Run it:**
```bash
sudo BACKUP_DIR=/srv/backups/mas-sular BACKUP_KEY_FILE=/etc/mas-sular/backup.key \
     bash scripts/backup/backup.sh
```

**Before every migration / release (mandatory):** the same command with a label, and
do not proceed unless it exits 0:
```bash
sudo BACKUP_LABEL=pre-migrate BACKUP_DIR=/srv/backups/mas-sular BACKUP_KEY_FILE=/etc/mas-sular/backup.key \
     bash scripts/backup/backup.sh
```
Also run it once **before the first real order**, and restore-drill it (§8).

Optional overrides: `COMPOSE_FILE`, `ENV_FILE`, `POSTGRES_SERVICE`, `POSTGRES_CONTAINER`,
`UPLOADS_VOLUME`, `BACKUP_LABEL`, `KEEP_POSTGRES`, `KEEP_UPLOADS`.

Retention preview (deletes nothing): `... bash scripts/backup/backup.sh --dry-run-retention`

**What the script does, in order:**
1. Atomic `mkdir` lock (no overlapping runs)
2. Preflight — Docker reachable, gpg present, key exists and is **outside** `BACKUP_DIR`,
   PostgreSQL container **healthy**, uploads volume exists
3. `pg_dump -Fc` **inside** the postgres container, over its local socket as the
   cluster's own user — no password is read, typed, put in argv or shell history.
   `pg_dump` takes a consistent snapshot without blocking application writes.
4. Integrity: `pg_restore --list` must read the archive and it must contain
   `_prisma_migrations` data
5. `tar czf` of the uploads volume mounted **`:ro`**, `--numeric-owner`; `gzip -t` + `tar tzf`
6. GPG symmetric AES-256 (SHA-512 S2K, 65M iterations)
7. **Verify by decrypting back and comparing SHA-256** — not trusted until proven recoverable
8. Manifest, then **atomic promotion** (built in a temp dir on the same filesystem, `mv`d only after every check)
9. Retention (§18)

Any failure: non-zero exit, `backup FAILED — no artifact promoted`, previous backups untouched. **VERIFIED**
(stopped database, wrong key, tampered artifact, invalid label).

---

## 5. Backup validation — **VERIFIED**

A backup is successful **only if all of these hold**. Exit code 0 alone is not acceptance.

- [ ] Script exit code `0` and a final `backup OK` line
- [ ] Both `.enc` artifacts exist and are non-zero; a manifest exists for the timestamp
- [ ] `sha256sum <artifact>` matches the manifest
- [ ] **A restore drill of the new artifact passes (§8)** — at least weekly and after every schema change
- [ ] The previous known-good backup is still present
- [ ] The off-server copy of this run exists (§16)

---

## 6. Encryption & key handling

GnuPG symmetric **AES-256**, SHA-512 S2K, passphrase via `--passphrase-file` only.
Tamper detection is **VERIFIED**: a single flipped byte fails decryption / the manifest checksum.

- Never pass the key on the command line; never print, log or commit it
- Never store it in `BACKUP_DIR` (enforced)
- **A backup encrypted with a lost key is not a backup** — escrow it (§17)

---

## 7. Restore decision tree

| # | Scenario | Immediate action | Artifact | Target | Proven? |
|---|---|---|---|---|---|
| **A** | App running, data corrupted | Freeze writes; identify last good backup | postgres `.enc` | **Drill first (§8)**, then cut over (§8.2) | ⚠️ drill proven; cutover not drilled on a VPS |
| **B** | Postgres container lost, volume intact | `docker compose up -d postgres` | none | existing volume | ✅ compose recreates |
| **C** | Postgres volume lost | §8.2 into a new volume | postgres `.enc` + key | new volume | ✅ restore mechanism **VERIFIED** |
| **D** | Uploads volume lost | §9 | uploads `.enc` + key | new volume | ✅ **VERIFIED** |
| **E** | Docker host restarted, disks intact | Containers restart (`unless-stopped`) | none | — | ✅ reboot simulation recovered |
| **F** | **Entire VPS lost** | §12 + artifacts from the off-server copy | **off-server artifacts + escrowed key** | new host | ❌ only as good as §16/§17 |
| **G** | Artifact corrupted | Previous artifact | older `.enc` | drill | ✅ retention keeps 14 |
| **H** | **Key unavailable** | **STOP. Escalate.** | — | — | ❌ **UNRECOVERABLE** |

---

## 8. PostgreSQL restore

### 8.1 Restore drill — **VERIFIED** (safe on production at any time)

`scripts/backup/restore-drill.sh` decrypts an artifact (checking the manifest
checksums first), restores it into a **disposable PostgreSQL 16 container with no
network**, prints what came back, and removes the container. It never touches the
application's containers or volumes.

```bash
sudo BACKUP_KEY_FILE=/etc/mas-sular/backup.key bash scripts/backup/restore-drill.sh \
  /srv/backups/mas-sular/mas-sular-postgres-<TS>.dump.enc \
  /srv/backups/mas-sular/manifest-<TS>.json
# Expect: DRILL_TABLES=<n>  DRILL_MIGRATIONS_APPLIED=<number of migrations>  DRILL_ROWS_Order=...
# Optional: DRILL_EXTRA_SQL='select max("createdAt") from "Order"'   (newest order in the backup)
```

### 8.2 Restoring the production database — **MANUAL, DESTRUCTIVE** (not drilled on a VPS)

> **Only after 8.1 has passed on the SAME artifact.** This replaces the live database;
> every write after the backup is lost. Take a fresh backup of the current (broken)
> state first if it still runs — you may need it for forensics.

```bash
C="docker compose --env-file ./production.env -f docker-compose.production.yml"

# 1. Stop everything that writes. Keep postgres running.
$C stop backend frontend admin

# 2. Decrypt — CHECK THE EXIT CODE (gpg writes output before validating it)
gpg --batch --quiet --pinentry-mode loopback --passphrase-file /etc/mas-sular/backup.key \
    -d -o /root/restore.dump /srv/backups/mas-sular/mas-sular-postgres-<TS>.dump.enc \
  || { rm -f /root/restore.dump; echo "DECRYPT FAILED - ABORT"; exit 1; }
sha256sum /root/restore.dump      # must equal the manifest's plaintext_sha256

# 3. Recreate the database EMPTY, then restore into it (inside the container, local socket)
$C exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
$C exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' < /root/restore.dump
shred -u /root/restore.dump

# 4. Bring the app back: backend-migrate applies any migration newer than the backup
$C up -d
```

Then §21. **Never "repair" a failed restore with `prisma migrate`/`db push`** — that masks a bad backup.

---

## 9. Uploads restore — **VERIFIED**

```bash
gpg --batch --quiet --pinentry-mode loopback --passphrase-file /etc/mas-sular/backup.key \
    -d -o /root/uploads.tar.gz /srv/backups/mas-sular/mas-sular-uploads-<TS>.tar.gz.enc \
  || { rm -f /root/uploads.tar.gz; echo "DECRYPT FAILED - ABORT"; exit 1; }
sha256sum /root/uploads.tar.gz && gzip -t /root/uploads.tar.gz && tar tzf /root/uploads.tar.gz >/dev/null

# Restore into a NEW volume first, verify, then point the stack at it (or copy into the live one)
docker volume create mas-sular_uploads_restore
docker run --rm -v mas-sular_uploads_restore:/restore -v /root:/in:ro debian:12-slim \
  tar xzf /in/uploads.tar.gz -C /restore --numeric-owner
docker run --rm -u 1000:1000 -v mas-sular_uploads_restore:/app/uploads alpine \
  sh -c 'touch /app/uploads/.t && rm /app/uploads/.t && echo WRITABLE'
```

> **Extract with GNU tar (debian/ubuntu image), not BusyBox** — BusyBox tar sets
> directory mtimes to extraction time (F17). Always `--numeric-owner` (the app runs as uid 1000).
> The automated test verifies byte-identical files and uid 1000 ownership after restore.

---

## 10. Redis — **do not restore**
Recreate (`docker compose up -d redis`); the cache warms itself. `/health/ready` → `"redis":"ok"`.

## 11. RabbitMQ — **rebuild, do not restore**
Recreate; consumers re-assert topology; the relay drains `OutboxEvent`; `ProcessedEvent`
prevents duplicate side effects. `/health/ready` → `"rabbitmq":"ok"`.

---

## 12. Full application recovery — **RTO NOT VERIFIED**

```
host + Docker
  └─ postgres            (service_healthy)
       └─ backend-migrate  (completes successfully — `prisma migrate deploy`)
            └─ backend     (also redis + rabbitmq healthy)
                 ├─ frontend
                 └─ admin
```

1. Provision the host, install Docker (`systemctl enable docker`)
2. Clone the repository at the **release tag**
3. Restore `production.env` and the backup key from escrow
4. `docker compose --env-file ./production.env -f docker-compose.production.yml up -d postgres`
5. Copy the artifacts back from the off-server store; restore-drill (§8.1); restore (§8.2 step 3)
6. Restore the uploads volume (§9)
7. `... up -d --build` — `backend-migrate` runs before `backend`
8. Reverse proxy / TLS; `/api/v1/health/ready`; §21

---

## 13. Failure handling

**STOP · never overwrite known-good data · keep the previous backup · escalate.**

| Failure | Action |
|---|---|
| `backup.sh` non-zero | Read the `ERROR:` line; nothing was promoted; the previous backup stands. Fix and re-run before any migration. |
| GPG non-zero exit | Delete the output immediately; try the previous artifact; if all fail suspect the key (§17) |
| Checksum mismatch | Discard (corrupt, or wrong manifest); fall back |
| `pg_restore` fails in the drill | Keep the drill output; try the previous artifact; do NOT restore production from it |
| Wrong key | **STOP.** Retrieve the correct key from escrow |
| Missing manifest | Integrity unverifiable — prefer an artifact that has one |
| Insufficient disk | Free space first; a partial restore is worse than none |

---

## 14. RPO / RTO

- **RPO = time since the last successful backup.** With the daily schedule (§15) that is
  up to 24 h, plus the explicit pre-migration backups. There is no point-in-time recovery.
- **RTO: NOT MEASURED** on the VPS. The local test restores a freshly migrated
  database in seconds; that says nothing about a production-size restore. Measure it
  with §8.1 on real data after go-live and record it here.
- (The timings previously listed here were measured against the retired MySQL setup
  and no longer apply.)

---

## 15. Scheduling — **MANUAL ACTION REQUIRED**

Nothing is scheduled until you install it. On the VPS (as root), daily at 02:15 UTC:

```bash
cat > /etc/cron.d/mas-sular-backup <<'CRON'
15 2 * * * root cd /opt/mas-sular && BACKUP_DIR=/srv/backups/mas-sular BACKUP_KEY_FILE=/etc/mas-sular/backup.key bash scripts/backup/backup.sh >> /var/log/mas-sular-backup.log 2>&1
CRON
```
(`/opt/mas-sular` = the repository checkout.) Check `/var/log/mas-sular-backup.log`
for `backup OK` daily until alerting exists (§19).

---

## 16. Off-server copy — **MANUAL ACTION REQUIRED**

Artifacts on the VPS die with the VPS. After each successful run, copy the new
`.enc` files and manifest to storage that survives loss of the VPS. They are
encrypted, so any provider works; the key must NOT travel with them. Examples:

```bash
# rsync to another host you control
rsync -a --ignore-existing /srv/backups/mas-sular/ backup@<OFFSITE_HOST>:/backups/mas-sular/
# or an rclone remote (S3/B2/Drive), configured once with `rclone config`
rclone copy /srv/backups/mas-sular <REMOTE>:mas-sular-backups --ignore-existing
```
Add the chosen line to the cron entry after the backup (`&& rsync ...`). **Choosing the
destination is an operator decision.** A Hostinger VPS snapshot is a useful extra
layer, not a substitute (same provider, whole-disk, not restorable per table).

---

## 17. Key escrow — **MANUAL ACTION REQUIRED**

Store a copy of `/etc/mas-sular/backup.key` in a password manager / secret store that is
not the VPS and not the off-server backup location. Test recovery once: fetch it from
escrow onto another machine and run §8.1 against an off-server artifact.

---

## 18. Retention

| Scope | Implementation | Status |
|---|---|---|
| PostgreSQL | `KEEP_POSTGRES=14` newest `.dump.enc` retained | ✅ **VERIFIED** |
| Uploads | `KEEP_UPLOADS=14` newest `.tar.gz.enc` retained | ✅ **VERIFIED** |
| Newest / last-remaining | Never deleted | ✅ by construction |
| Scope | Only this project's file names, only inside `BACKUP_DIR` | ✅ |
| Weekly / monthly tiers | — | ❌ keep them in the off-server store (e.g. its lifecycle rules) |
| Manifests | not pruned | ❌ small; prune by hand occasionally |

Pre-migration runs count toward the 14. The off-server store should keep longer
(recommended: 14 daily + 8 weekly + 6 monthly).

---

## 19. Monitoring & alerting — **NOT IMPLEMENTED**

A failing backup is invisible until someone reads the log. Minimum: check
`/var/log/mas-sular-backup.log` daily; later alert on a missing `backup OK` line,
low disk, or a failed off-server copy.

---

## 20. Recovery checklist

```
[ ] Identify incident and scope (database? uploads? whole host?)
[ ] Decide the acceptable recovery point (which backup)
[ ] Freeze writes if the live system is still serving
[ ] Verify the artifact against its manifest; confirm the key is available
[ ] Restore drill (§8.1) passes on that artifact
[ ] Restore the database (§8.2) / uploads (§9)
[ ] Recreate Redis and RabbitMQ (no restore); confirm the outbox relay drains
[ ] backend-migrate completes; backend, frontend, admin healthy
[ ] §21 checks
[ ] Declare recovery; record the actual RTO in §14
```

---

## 21. Post-recovery verification

Non-destructive checks only:

- [ ] `GET /api/v1/health` → ok; `GET /api/v1/health/ready` → postgres/redis/rabbitmq ok
- [ ] Customer login; a known customer's order list renders
- [ ] Payment records and statuses intact
- [ ] An existing uploaded receipt / product image loads
- [ ] Admin login and order list
- [ ] `OutboxEvent` backlog draining, not growing

> Do not run checkout or payment-producing operations as routine verification — they
> create real orders and can contact the payment gateway and couriers.

---

## 22. Readiness verdict

| Capability | Status |
|---|---|
| PostgreSQL backup (`pg_dump -Fc`, encrypted, verified) | ✅ **PROVEN locally** |
| Uploads backup | ✅ **PROVEN locally** |
| Restore drill / uploads restore | ✅ **PROVEN locally** |
| Loud failure, nothing promoted | ✅ **PROVEN locally** |
| Point-in-time recovery | ❌ **does not exist** (by design of this mechanism) |
| Scheduling | ⚠️ **MANUAL** (§15) |
| Off-server copy | ⚠️ **MANUAL** (§16) — until done, VPS loss = data loss |
| Key escrow | ⚠️ **MANUAL** (§17) |
| Production-scale RTO | ❌ **NOT MEASURED** |
