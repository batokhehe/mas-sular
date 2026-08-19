# Mas Sular — Backup & Disaster Recovery Runbook

**Audience:** any engineer with shell + Docker access. No prior context assumed.
**Last validated:** Phase 5J.13 (Steps 1–9), against the local Docker stack.

Every procedure below carries a status label. Read it before relying on the step:

| Label | Meaning |
|---|---|
| **VERIFIED** | Executed and independently checked during Phase 5J.13 |
| **AVAILABLE, NOT PRODUCTION-VERIFIED** | Mechanism works; never exercised at production scale or on a VPS |
| **MANUAL ACTION REQUIRED** | A human must do this; no automation exists |
| **NOT IMPLEMENTED** | Does not exist. Do not assume it protects you. |

---

## 1. Purpose

**Protects:** the MySQL application database and the customer uploads volume — the only two data classes that cannot be reconstructed from source control or by restarting a service.

**Restores:** those two data classes into an isolated target, with verified schema, metadata, ownership and integrity.

**Applies to:** the Dockerised Mas Sular stack defined by `docker-compose.production.yml`.

**NOT covered:**
- Off-server / off-site backup — **NOT IMPLEMENTED** (see §16)
- Automated scheduling — **NOT IMPLEMENTED** (see §15)
- Encryption-key escrow or recovery — **NOT IMPLEMENTED** (see §17)
- Full application recovery timing — **NOT VERIFIED** (see §12)
- VPS provisioning, DNS, TLS certificates

> **Scope warning.** All timings in this runbook were measured against a **local Docker drill** with a **2.98 MB** database and an **8,260-byte** uploads volume containing one synthetic file. They demonstrate that the mechanism works. **They are not a production SLA** and must not be quoted as one.

---

## 2. System recovery model

| Component | Class | Backup? | Restore? | Rebuild? | Depends on |
|---|---|---|---|---|---|
| **MySQL** | **CRITICAL** | Yes | Yes | No | — |
| **Uploads volume** | **CRITICAL** | Yes | Yes | No | — |
| **Redis** | EPHEMERAL | **No** | **No** | Yes — recreate empty | — |
| **RabbitMQ** | REBUILDABLE | **No** | **No** | Yes — topology re-asserted on consumer boot | MySQL (`OutboxEvent` is authoritative) |
| **Backend** | REBUILDABLE | No | No | Build from `mas-sular-be` | MySQL, migrations, Redis, RabbitMQ |
| **Frontend** | REBUILDABLE | No | No | Build from `mas-sular-fe` | Backend (runtime only) |
| **Admin** | REBUILDABLE | No | No | Build from `mas-sular-admin` | Backend (runtime only) |
| **Secrets / config** | **CRITICAL** | **Yes — separately** | Yes | No | Must exist before anything starts |

**Why Redis and RabbitMQ are not backed up** (verified in Phase 5J.13 Step 2):
- Redis runs with `save ""` and `appendonly no`. It is a cache; the application treats it as non-authoritative.
- RabbitMQ held 9 durable queues with **0 messages**; topology is recreated by `assertExchange`/`assertQueue` at consumer startup. **`OutboxEvent` rows in MySQL are the authoritative record** — the relay republishes anything unsent. Backing up Mnesia would add restore-ordering risk for no recovery value.

**External dependencies required after recovery:** `GOOGLE_CLIENT_ID`, `MIDTRANS_SERVER_KEY`, `MIDTRANS_CLIENT_KEY`, `RESEND_API_KEY` (and Qontak keys if WhatsApp is enabled). Without these the stack starts but cannot authenticate customers or take payments.

---

## 3. Backup artifact layout

Conceptual layout. **The key must never live inside the backup directory** — the backup script refuses to run if it does.

```
<BACKUP_DIR>/                                  # e.g. /srv/backups
  mas-sular-mysql-YYYYMMDD-HHMMSSZ.sql.gz.enc
  mas-sular-uploads-YYYYMMDD-HHMMSSZ.tar.gz.enc
  manifest-YYYYMMDD-HHMMSSZ.json

<KEY_DIR>/                                     # e.g. /etc/mas-sular  — DIFFERENT filesystem/host in production
  backup.key
```

- Timestamps are **UTC**, `Z`-suffixed.
- MySQL and uploads artifacts from one run **share the run timestamp**.
- The **encrypted artifact is the canonical retained copy**. Plaintext is temporary and deleted by the script after successful encryption + verification.

Manifest contents (safe metadata only — no credentials, no PII, no SQL):

```json
{
  "timestamp": "...", "database": "mas_sular",
  "mysql":   { "artifact": "...", "sha256": "...", "size": 0, "plaintext_sha256": "..." },
  "uploads": { "artifact": "...", "sha256": "...", "size": 0, "plaintext_sha256": "..." },
  "encryption": { "tool": "gpg", "algorithm": "AES-256", "integrity": "OpenPGP MDC" }
}
```

---

## 4. Backup procedure — **VERIFIED**

Use the verified script: **`scripts/backup/backup.sh`** (repository root of the workspace).

```bash
BACKUP_DIR=/srv/backups \
BACKUP_KEY_FILE=/etc/mas-sular/backup.key \
./scripts/backup/backup.sh
```

Optional overrides: `COMPOSE_FILE`, `ENV_FILE`, `MYSQL_SERVICE`, `MYSQL_DATABASE`, `UPLOADS_VOLUME`, `KEEP_MYSQL`, `KEEP_UPLOADS`.

Retention preview (deletes nothing):
```bash
BACKUP_DIR=... BACKUP_KEY_FILE=... ./scripts/backup/backup.sh --dry-run-retention
```

**What the script does, in order:**
1. Acquire an atomic `mkdir` lock (prevents overlapping runs; `flock` is not required)
2. Preflight — Docker reachable, gpg present, key exists and is **outside** `BACKUP_DIR`, MySQL container **healthy**, uploads volume exists
3. `mysqldump --single-transaction --routines --triggers --events --set-gtid-purged=OFF --hex-blob --no-tablespaces` (password via `MYSQL_PWD`, never argv) → `gzip -9`
4. `tar czf` the uploads volume mounted **`:ro`**, with `--numeric-owner`
5. GPG symmetric AES-256 encryption (SHA-512 S2K, 65M iterations)
6. **Verify by decrypting back and comparing SHA-256** — the artifact is not trusted until proven recoverable
7. Write manifest
8. **Atomic promotion** — everything is built in a temp workdir on the same filesystem and `mv`d only after every check passes
9. Retention

**Do not run backups against an unhealthy MySQL.** The script already refuses.

---

## 5. Backup validation — **VERIFIED**

A backup is successful **only if all of these hold**. Exit code 0 alone is not acceptance.

- [ ] Script exit code `0`
- [ ] Both `.enc` artifacts exist and are non-zero
- [ ] Manifest exists for the run timestamp
- [ ] `sha256sum <artifact>` matches the manifest entry
- [ ] Decrypt succeeds and the decrypted SHA-256 matches `plaintext_sha256`
- [ ] `gzip -t` passes on the decrypted MySQL dump
- [ ] `tar tzf` passes on the decrypted uploads archive
- [ ] The previous known-good backup is still present

---

## 6. Encryption & key handling

**Mechanism — VERIFIED:** GnuPG symmetric, **AES-256**, SHA-512 S2K, passphrase supplied via `--passphrase-file`.

> `openssl enc` was tested and **explicitly refuses AEAD ciphers** (`"AEAD ciphers not supported"`). Do not substitute it.

**Tamper detection — VERIFIED:** flipping a single byte in an encrypted artifact causes decryption to fail (non-zero exit).

**Rules:**
- Never pass the key on the command line — use `--passphrase-file`
- Never print, log, or commit the key
- Never store the key in `BACKUP_DIR` (the script enforces this)

### Current key state: **NOT PRODUCTION READY (F6)**
Temporary local key, on the same host as the backups, no KMS, no escrow, no tested recovery, no rotation procedure.

### Required production process — **MANUAL ACTION REQUIRED**
1. Obtain the production key from an approved secret store
2. Run backup → encrypt → store artifact
3. **Escrow the key independently of the backup host**
4. Periodically test decryption of a real artifact
5. Rotate under a controlled, documented procedure

> **A backup encrypted with a lost key is not a backup.** Key escrow is as important as the backup itself.

---

## 7. Restore decision tree

| # | Scenario | Immediate action | Artifact needed | Restore target | Proven? |
|---|---|---|---|---|---|
| **A** | App running, data corrupted | Freeze writes; identify last good backup | MySQL `.enc` | **Scratch first**, then cut over | ⚠️ scratch restore proven; cutover **not** proven |
| **B** | MySQL container lost, volume intact | Recreate container against existing volume | none | existing volume | ✅ compose recreates |
| **C** | MySQL volume lost | §8 | MySQL `.enc` + key | new volume | ✅ **VERIFIED** |
| **D** | Uploads volume lost | §9 | uploads `.enc` + key | new volume | ✅ **VERIFIED** |
| **E** | Docker host failed, disks intact | Restart Docker, `compose up -d` | none | — | ⚠️ partially proven |
| **F** | **Entire VPS lost** | §12 + restore from off-server copy | **off-server artifacts + escrowed key** | new host | ❌ **NOT PROVEN — no off-server copy exists (H1)** |
| **G** | Backup artifact corrupted | Fall back to the previous artifact | older `.enc` | scratch | ✅ retention keeps 24 MySQL / 7 uploads |
| **H** | **Encryption key unavailable** | **STOP. Escalate.** | — | — | ❌ **UNRECOVERABLE (F6)** |

**Host failure (E) and host loss (F) are different problems.** Only the first is currently survivable.

---

## 8. MySQL restore procedure — **VERIFIED** (into scratch)

```bash
# 1-2. Identify the incident. Freeze writes if the live DB is still serving.

# 3. Identify the authoritative backup (newest, or the last known-good)
ls -t "$BACKUP_DIR"/mas-sular-mysql-*.sql.gz.enc | head -1

# 4. Verify against the manifest — MUST match before proceeding
sha256sum <artifact>
grep -A4 '"mysql"' "$BACKUP_DIR/manifest-<TS>.json"

# 5-7. Decrypt — CHECK EXIT CODE FIRST (see warning below)
gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$BACKUP_KEY_FILE" \
    -d -o /tmp/restore/dump.sql.gz <artifact> \
  || { rm -f /tmp/restore/dump.sql.gz; echo "DECRYPT FAILED — ABORT"; exit 1; }

# 8-9. Verify checksum, then format
sha256sum /tmp/restore/dump.sql.gz     # must equal manifest plaintext_sha256
gzip -t /tmp/restore/dump.sql.gz

# 10. Provision a CLEAN, ISOLATED MySQL (same major.minor: 8.4)
docker volume create restore-data-$(date -u +%s)
docker network create restore-net-$(date -u +%s)
docker run -d --name restore-mysql --network restore-net-... \
  -e MYSQL_ROOT_PASSWORD=<scratch-only> -e MYSQL_DATABASE=mas_sular_restore_drill \
  -v restore-data-...:/var/lib/mysql mysql:8.4
#    NO published ports. Do NOT attach application containers.

# 11. Restore
gzip -dc /tmp/restore/dump.sql.gz | docker exec -i restore-mysql \
  sh -c 'MYSQL_PWD=<scratch-only> mysql -u root mas_sular_restore_drill'

# 12-13. Validate: table/column/index/FK counts vs source; orphan scan;
#        _prisma_migrations count (expect all applied, 0 rolled back)
```

> ### ⚠️ Decryption safety (F7) — mandatory
> **GPG streams plaintext to the output file *before* validating integrity at the end.** Bytes exist on disk even for a corrupt or tampered artifact.
> **The exit code is the only trustworthy signal.** Always: run GPG → check exit code → **delete the output on any failure** → only then checksum → only then validate format → only then restore.
> Never decrypt directly into the final restore destination.

**14–17.** Start the application against the restored data, verify `/health` and `/health/ready`, run §21 smoke tests, then declare recovery.

> **Never restore over the live database until a scratch restore has validated the artifact.** Restoring to scratch first is the verified path.

---

## 9. Uploads restore procedure — **VERIFIED**

```bash
# 1-2. Identify artifact + verify manifest checksum
ls -t "$BACKUP_DIR"/mas-sular-uploads-*.tar.gz.enc | head -1

# 3-5. Decrypt with the same exit-code-first discipline as §8
gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$BACKUP_KEY_FILE" \
    -d -o /tmp/restore/uploads.tar.gz <artifact> \
  || { rm -f /tmp/restore/uploads.tar.gz; echo "DECRYPT FAILED — ABORT"; exit 1; }

# 6-7. Verify
sha256sum /tmp/restore/uploads.tar.gz   # must equal manifest plaintext_sha256
gzip -t /tmp/restore/uploads.tar.gz && tar tzf /tmp/restore/uploads.tar.gz >/dev/null

# 8. Provision a disposable restore volume
docker volume create uploads-restore-$(date -u +%s)

# 9-10. Extract with GNU tar — see warning
docker run --rm -i -v uploads-restore-...:/restore debian:12-slim \
  sh -c 'cat > /tmp/u.tar.gz && tar xzf /tmp/u.tar.gz -C /restore --numeric-owner' \
  < /tmp/restore/uploads.tar.gz

# 11-13. Verify uid:gid (1000:1000), modes (644 files / 755 dirs), and mtimes
# 14. Application-UID write test
docker run --rm -u 1000:1000 -v uploads-restore-...:/app/uploads alpine \
  sh -c 'touch /app/uploads/.t && rm /app/uploads/.t && echo WRITABLE'
```

> ### 🚨 Use GNU tar, not BusyBox/alpine (F17)
> **Empirically proven during Phase 5J.13 Step 8:** BusyBox tar **1.37.0** silently sets directory mtimes to *extraction time* instead of restoring them. GNU tar **1.34** restored them exactly.
> **Restore with a `debian`/`ubuntu` image.** Alpine is fine for *creating* the archive (mtimes are written correctly) — the defect is extraction-only.
> Always pass `--numeric-owner`: the app runs as uid 1000, and name-based resolution can silently remap ownership.

**15–17.** Compare file checksums against the manifest, smoke-test an upload/download, declare recovery.

---

## 10. Redis recovery — **do not restore**

Redis is **EPHEMERAL**. There is no backup and none is needed.

1. Recreate the container (`docker compose up -d redis`)
2. Allow the cache to warm naturally
3. Verify connectivity via `/health/ready` → `"redis":"ok"`

**Latent observation (H2):** BullMQ queues (`orders`, `inventory`, `payments`, `notifications`) are *registered* but have **no producers** and held 0 jobs. If a producer is ever added, Redis becomes business-critical while persistence is off — **enable AOF or remove the unused registration before enqueuing real work.** Not currently an incident.

---

## 11. RabbitMQ recovery — **rebuild, do not restore**

1. Recreate the container (`docker compose up -d rabbitmq`)
2. Start consumers — topology is re-asserted automatically (`assertExchange` / `assertQueue`)
3. Verify `/health/ready` → `"rabbitmq":"ok"`
4. Confirm the outbox relay drains `OutboxEvent`
5. Confirm no duplicate side effects — consumers deduplicate via `ProcessedEvent`

**Durable messages are NOT backed up.** In-flight unacknowledged messages are lost on host failure and are recovered by **replaying `OutboxEvent` from MySQL**, which is the authoritative record.

---

## 12. Full application recovery — **RTO NOT VERIFIED**

Dependency order taken from `docker-compose.production.yml`:

```
host + Docker
  └─ mysql            (must be service_healthy)
       └─ backend-migrate   (must complete successfully — runs `prisma migrate deploy`)
            └─ backend      (also requires redis + rabbitmq healthy)
                 ├─ frontend
                 └─ admin
```

1. Provision host, install Docker
2. Clone the three deployment repos (`mas-sular-be`, `-fe`, `-admin`)
3. **Restore `production.env` secrets and the backup encryption key**
4. `docker compose -f docker-compose.production.yml build`
5. Start `mysql`; **restore the database (§8)**
6. **Restore the uploads volume (§9)**
7. `docker compose up -d` — `backend-migrate` runs before `backend` automatically
8. Verify `/health` and `/health/ready`
9. DNS / TLS / reverse proxy
10. §21 smoke tests

> **FULL APPLICATION RTO = NOT VERIFIED.** No drill has provisioned a fresh host, rebuilt images, restored into a live stack and served traffic. **Do not extrapolate from the 2.1 s MySQL restore** — real recovery is dominated by provisioning, image builds and data transfer, none of which have been measured.

---

## 13. Failure handling

Universal rule: **STOP · do not overwrite known-good data · preserve the previous backup · escalate.**

| Failure | Action |
|---|---|
| GPG non-zero exit | **Delete the output immediately.** Try the previous artifact. If all fail → suspect key (§17) |
| Checksum mismatch | Discard. Artifact is corrupt or the wrong manifest was used. Fall back. |
| `gzip -t` fails | Discard; fall back to the previous artifact |
| `tar` fails | Discard; fall back |
| Wrong key | **STOP.** Do not guess. Retrieve the correct key from escrow |
| Missing artifact | Use the previous timestamp; check retention did not over-prune |
| Missing manifest | Artifact integrity is unverifiable — treat as untrusted; prefer an artifact that has one |
| Insufficient disk | Free space **before** restoring; a partial restore is worse than none |
| Docker unavailable | Restore the daemon first; nothing else is possible |
| MySQL restore fails | Keep the scratch instance for diagnosis. **Do not "repair" with `prisma migrate`** — that masks a bad backup |
| Uploads restore fails | Check GNU tar is in use (F17) before suspecting the artifact |

---

## 14. RPO / RTO

### Measured — **MECHANICALLY VERIFIED, NON-PRODUCTION-SCALE**

| Metric | Measured | Dataset |
|---|---|---|
| Full backup pipeline (both components) | **7,072 ms** | 2.98 MB + 8 KB |
| MySQL backup phase | 1,353 ms | 2.98 MB |
| Uploads backup phase | 1,778 ms | 8,260 B |
| MySQL decrypt | 375 ms | — |
| **MySQL restore** | **2,119 ms** | 2.98 MB |
| MySQL recovery incl. scratch startup + validation | ≈ 25 s | — |
| Uploads decrypt | 346 ms | — |
| **Uploads restore (GNU tar)** | **724 ms** | 8,260 B |

### Current RPO

**NOT VERIFIED.** No scheduler is installed (F18); execution is manual. The last recoverable point is whenever someone last ran the script.

### Targets — **TARGETS ONLY, not measurements**

| Component | Target |
|---|---|
| MySQL RPO | ≤ 1 hour |
| Uploads RPO | ≤ 24 hours |
| MySQL RTO | ≤ 2 hours at 5–50 GB |
| Uploads RTO | ≤ 2 hours at 10–100 GB |
| Full application RTO | ≤ 4 hours |
| Host-loss RPO/RTO | ≤ 1 h / ≤ 4 h — **currently unachievable** (H1) |

---

## 15. Scheduling gap (F18) — **NOT IMPLEMENTED**

There is **no scheduler**. The "hourly"/"daily" cadence exists only as comments beside `KEEP_MYSQL=24` / `KEEP_UPLOADS=7`. Retention encodes intent; it does not execute anything.

**MANUAL ACTION REQUIRED:** on the Linux VPS, schedule the verified script (cron or a systemd timer) to run hourly, logging to a file, with the lock left in place to prevent overlap. **Until then, RPO is undefined.**

---

## 16. Off-server backup gap (H1) — **NOT IMPLEMENTED**

Artifacts currently live on the same host as the workload.

```
Application host ──▶ encrypted backup ──▶ [ MISSING: independent destination ]
```

The destination must survive loss of the application VPS. **No provider is selected** — that is a project decision, not a runbook default.

**Consequence: total VPS loss is currently unrecoverable.** This is the single largest DR gap.

---

## 17. Key escrow gap (F6) — **NOT IMPLEMENTED**

The key is local and test-only, on the backup host, with no escrow and no tested recovery.

**Required:** backup host ≠ key escrow location, and **key recovery must be tested** before DR is declared complete. If the key cannot be recovered, every encrypted artifact is permanently unreadable.

---

## 18. Retention

| Scope | Implementation | Status |
|---|---|---|
| MySQL | `KEEP_MYSQL=24` newest retained | ✅ **VERIFIED** (9 → 3 with `KEEP=3`) |
| Uploads | `KEEP_UPLOADS=7` newest retained | ✅ **VERIFIED** |
| Newest / last-remaining protection | Never deleted | ✅ **VERIFIED** |
| Scope safety | Only files matching the project naming convention inside `BACKUP_DIR` | ✅ **VERIFIED** — unrelated archives survived |
| Weekly / monthly tiers | — | ❌ **GAP (F12)** |
| Manifest retention | — | ❌ **GAP (F13)** — grows unbounded |

**Target (not implemented):** 24 hourly + 7 daily + 4 weekly for MySQL; prune manifests alongside their artifacts.

---

## 19. Monitoring & alerting (F14) — **NOT IMPLEMENTED**

No alerting exists. A failing backup is invisible until a restore is attempted.

**Required alerts:** backup failure · encryption failure · checksum mismatch · expected artifact missing · low disk · key access failure · off-server copy failure.

---

## 20. Recovery checklist

```
[ ] Identify incident and scope (which data class?)
[ ] Determine acceptable data loss / target recovery point
[ ] Freeze writes if the live system is still serving
[ ] Identify latest known-good artifact
[ ] Verify manifest checksum matches artifact
[ ] Confirm encryption key is available
[ ] Decrypt  → CHECK EXIT CODE FIRST, delete output on failure
[ ] Verify decrypted SHA-256 against manifest
[ ] Verify gzip / tar integrity
[ ] Restore MySQL into SCRATCH and validate
[ ] Restore uploads with GNU TAR and validate metadata
[ ] Recreate Redis (no restore)
[ ] Recreate RabbitMQ (no restore); confirm outbox relay drains
[ ] Run prisma migrate deploy (backend-migrate)
[ ] Start backend
[ ] Start frontend / admin
[ ] /health and /health/ready all ok
[ ] Smoke test (§21)
[ ] Verify payments / orders / uploads
[ ] Monitor for anomalies
[ ] Declare recovery + record actual RTO
```

---

## 21. Post-recovery verification

Non-destructive checks only:

- [ ] `GET /api/v1/health` → `status: ok`
- [ ] `GET /api/v1/health/ready` → `mysql/redis/rabbitmq: ok`
- [ ] Customer login (Google OAuth)
- [ ] Order list renders for a known customer
- [ ] Payment records readable with correct statuses
- [ ] Gateway transaction data intact (`providerOrderId` present)
- [ ] Inventory counts plausible
- [ ] An existing uploaded receipt downloads correctly
- [ ] Admin panel login and order list
- [ ] `OutboxEvent` backlog draining, not growing

> **Do not run checkout or payment-producing operations as part of routine verification** without explicit approval — they create real orders and can contact the payment gateway.

---

## 22. Current production readiness verdict

| Capability | Status |
|---|---|
| Backup mechanism | ✅ **PROVEN** |
| Restore mechanism | ✅ **PROVEN** |
| RPO | ❌ **NOT PROVEN** (no scheduler) |
| Host-loss DR | ❌ **NOT PROVEN** (no off-server copy) |
| Key recovery | ❌ **NOT PROVEN** (no escrow) |
| Full application RTO | ❌ **NOT PROVEN** (never drilled) |
| Off-server durability | ❌ **NOT IMPLEMENTED** |
| Automated scheduling | ❌ **NOT IMPLEMENTED** |
| Alerting | ❌ **NOT IMPLEMENTED** |

**Overall disaster recovery posture: PARTIAL.**

The backup and restore *mechanisms* are production-grade and independently verified. The *disaster recovery posture* is not: without scheduling, off-server copies and key escrow, this system cannot survive the loss of its host.

**The existence of this runbook does not make the system production-ready.**

### Ordered actions to close the gap
1. **Off-server destination (H1)** — nothing else matters if the host is gone
2. **Key escrow + tested recovery (F6)** — an unrecoverable key voids every backup
3. **Scheduler (F18)** — converts an undefined RPO into a bounded one
4. **Alerting (F14)** — makes silent failure visible
5. **Full-stack recovery drill (F20)** — the only way to obtain a real RTO
6. **Retention tiers + manifest pruning (F12, F13)**
