# Address phone backfill — production runbook

> ## 61AG.3.23 DOES NOT EXECUTE PRODUCTION BACKFILL.
> This document is a readiness review and a procedure for a **future**, separately
> approved change. Every command in section C is marked **NOT EXECUTED**.
> As of this review, production **cannot be reached from a workstation** and the
> preconditions in section B are **not met**.

Normalises legacy `Address.phone` values to the canonical Indonesian mobile form
`628…` that [`normalizeIndonesianMobile()`](../../src/common/utils/phone.util.ts)
has enforced on write since PAXELBOX-61AG.3.20. Rows written before that contract
are still in whatever shape the customer typed.

| Phase | Scope | Status |
|---|---|---|
| 61AG.3.21 | Tool built; proven on a disposable MySQL | done |
| 61AG.3.22 | Applied to shared dev: 6 rows repaired, 1 quarantined | done |
| 61AG.3.23 | Production readiness review (this document) | **read-only; blocked** |

---

## A. Read-only production audit

**This could not be performed.** Production MySQL is not reachable from a
workstation, by design:

- `production.env` `DATABASE_URL` names host `mysql` — a bare docker-compose
  **service name**, not a routable host. DNS resolution fails (`getaddrinfo`).
- [`docker-compose.production.yml`](../../../docker-compose.production.yml) puts
  MySQL on the `internal` network with the explicit comment
  `# NO ports: — 3306 must never reach the host.`

That is a security control working correctly and **must not be worked around** —
no port publishing, no tunnel, no temporary exposure.

The audit must instead run **on the production host, inside the compose network**,
as a read-only step of the approved change. It produces, for every `Address` row:

| Field | Note |
|---|---|
| `id` | full UUID (needed for the allowlist) |
| phone, masked | `maskPhone()` — never the full number |
| classification | A canonical · B valid-mobile-non-canonical · C landline · D malformed |
| proposed action | `SAFE_NORMALIZE` · `MANUAL_REVIEW` · `NO_ACTION` |
| order / shipment / outbox counts | blast radius per row |

```bash
# NOT EXECUTED — read-only audit, run ON the production host
docker compose -f docker-compose.production.yml exec -T backend \
  npx tsx prisma/tools/normalize-address-phone.ts | tee audit-$(date +%F).log
```

Dry run is the default: the tool writes nothing without `--apply`, and the write
guard is never even reached in this mode.

### Schema compatibility

The application and production are built from the same repo and migrated by the
`backend-migrate` compose service, so drift is not expected — but it is
**unverified** and must be confirmed during the audit:

| Object | Expected | Why it matters |
|---|---|---|
| `Address.phone` | `VARCHAR(191) NOT NULL` | canonical form is shorter, never longer — no truncation risk |
| `Address.updatedAt` | `DATETIME(3) NOT NULL`, **no** `ON UPDATE` | so the bump comes from Prisma, not the server |
| `Address.deletedAt` | `DATETIME(3) NULL` | the tool scopes to `deletedAt IS NULL` |
| indexes on `Address` | `userId+isDefault`, `deletedAt`, PK only | **no unique index on `phone`** — collisions cannot fail the write |
| `User.phone` | `VARCHAR(191) NULL` | the only alternative source for a malformed row |
| `Order`, `Shipment` | **no** phone column | nothing to keep in sync |
| `NotificationOutbox.recipient` | `VARCHAR(255)` | frozen send-time snapshot; deliberately untouched |

Confirm with `SHOW CREATE TABLE Address` and compare against
[`schema.prisma`](../schema.prisma) plus the migration history.

---

## B. Approval gate

Every box must be true **before** section C runs. Today, three are not.

- [ ] Change ticket raised and approved; maintenance window agreed
- [ ] Read-only audit (section A) completed on production, output reviewed
- [ ] Candidate set reviewed **by a data owner**, not just engineering
- [ ] Explicit allowlist of approved `Address.id` values agreed in writing
- [ ] **Backup taken and verified** — see below
- [ ] **Restore path proven** for "data corrupted → cut back over"
- [ ] Approval mechanism implemented in the tool (section C.0) and tested
- [ ] Two people present: one running, one reviewing

### Backup requirements — currently NOT SATISFIED

[`scripts/backup/RUNBOOK.md`](../../../scripts/backup/RUNBOOK.md) documents a
verified backup and a verified restore *into scratch*. Three gaps block a
production data mutation:

| Gap | Impact on this backfill |
|---|---|
| **F6** — encryption key is temporary, local, on the same host as the backups; no escrow, no tested recovery | Restore scenario **H (key unavailable) is UNRECOVERABLE**. A backup you cannot decrypt is not a backup. |
| **H1** — no off-server copy | Scenario **F (host lost) NOT PROVEN**. |
| Scenario **A** cutover unproven | This is *precisely* the recovery path a bad backfill needs: restore good data and cut back over. Scratch restore is proven; cutover is not. |

Required before execution:

1. Full MySQL backup via `scripts/backup/backup.sh`, manifest checksum verified (§4–5)
2. Key obtained from an approved secret store and **escrowed off-host** (§6)
3. Decryption of the *actual* artifact tested — not a sample
4. A targeted `Address` snapshot (below), stored beside the change ticket
5. Point-in-time recovery confirmed available, or its absence accepted in writing

**Targeted snapshot** — the minimum needed to reconstruct any row:

```
id (full)  |  phone (original)  |  updatedAt (original, ms)  |  userId
```

This one file necessarily contains plaintext phone numbers, because rollback
needs the original values. Treat it as customer PII: restricted access, deleted
once the change is closed. Everything *else* in this process uses SHA-256
fingerprints instead, which prove a value did not change without storing it.

---

## C. Future production execution — **NOT EXECUTED**

### C.0 Required guard change (not implemented — deliberately)

The tool **refuses production unconditionally today**, and this review did not
weaken that. Verified: it refuses `mas_sular` even when given a full
`--target` + `--ids` approved-run argument set.

Executing against production therefore requires a **future, reviewed code
change** adding a production path that demands *all* of:

1. `--apply`
2. `--target=<exact production database name>`
3. `--ids=<exact reviewed allowlist>`
4. a change-ticket identifier, recorded in the run output
5. proof-of-backup input (artifact id + verified checksum)
6. interactive typed confirmation (not a flag — flags end up in shell history)
7. `NODE_ENV` assertion consistent with a deliberate production run

Do not add this speculatively. Design it when the change is actually scheduled,
and re-run [`normalize-address-phone.verify.ts`](./normalize-address-phone.verify.ts)
afterwards — its guard matrix asserts production is refused, so that test must be
updated consciously rather than incidentally.

### C.1 Sequence

```bash
# ALL NOT EXECUTED — run on the production host, in the compose network

# 1. Identity — must print the expected production database, or STOP
docker compose -f docker-compose.production.yml exec -T mysql \
  mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" -e 'SELECT DATABASE(), VERSION();' mas_sular

# 2. Backup + verify (see scripts/backup/RUNBOOK.md §4-5), escrow the key

# 3. Targeted snapshot of the approved rows, stored with the change ticket

# 4. Dry run — review every proposed change
docker compose -f docker-compose.production.yml exec -T backend \
  npx tsx prisma/tools/normalize-address-phone.ts

# 5. Human approval of the exact allowlist

# 6. Apply — explicit ids only, NEVER a pattern
docker compose -f docker-compose.production.yml exec -T backend \
  npx tsx prisma/tools/normalize-address-phone.ts \
    --apply --target=mas_sular --ids=<approved,uuid,list>

# 7. Idempotency — re-run the identical command; expect "applied: 0 row(s)"
```

**Never** use a pattern-based update. The following is forbidden, because it
cannot be reviewed, cannot be rolled back precisely, and will silently catch rows
nobody approved:

```sql
-- FORBIDDEN
UPDATE Address SET phone = ... WHERE phone LIKE '08%';
```

### C.2 Verification after apply

| Check | Expectation |
|---|---|
| affected rows | exactly the allowlist size (asserted in-transaction; mismatch rolls back) |
| classification | approved rows now A; malformed rows still D |
| immutable fields | 17 other `Address` columns byte-identical |
| `updatedAt` | **bumped** on repaired rows — expected, see below |
| unrelated rows | count, id set and every column unchanged |
| `NotificationOutbox` | recipient snapshots unchanged; nothing created or sent |
| shipment path | `order.address.phone` resolves canonical ([shipment.service.ts:232](../../src/modules/shipment/shipment.service.ts)) |
| Qontak contract | `normalizePhoneNumber()` is a fixed point on the stored value |

Compare with SHA-256 field fingerprints and **millisecond-precision** timestamps.
`String(date)` truncates to seconds and will hide a sub-second bump — this exact
mistake produced a false "nothing changed" reading during 61AG.3.21.

---

## D. Rollback

### D.1 Before commit — automatic

The apply runs in one transaction with compare-and-set on the old value
(`WHERE id = ? AND phone = <original>`) and an affected-row assertion. Any
mismatch throws and the whole transaction rolls back. Proven: forcing a CAS miss
after one row had already been updated rolled that row back to its original
value, committing nothing.

### D.2 After commit — targeted compensation (preferred)

Restore per row from the targeted snapshot, with CAS in the other direction so a
row edited by a customer in the meantime is never clobbered:

```sql
-- NOT EXECUTED — one statement per approved row
UPDATE Address
   SET phone = :originalPhone
 WHERE id = :approvedId
   AND phone = :canonicalPhone;   -- CAS: only if still exactly what we wrote
-- affected rows must be 1; if 0, STOP and escalate — the row changed since
```

**`updatedAt` will NOT be restored.** It is a plain `DATETIME(3)` with no
`ON UPDATE` clause, so `@updatedAt` is applied client-side; a rollback is another
write and moves it again. Rolling it back would require setting it explicitly
from the snapshot, which is itself a falsification of the audit trail. Decide
which you want *before* executing, and record the decision — do not discover it
afterwards. Nothing currently reads `Address.updatedAt` (the compare-and-swap
concurrency guards are on `AdminRole` and `Shipment`), so leaving it moved is the
recommended default.

### D.3 Last resort — full restore

`scripts/backup/RUNBOOK.md` §7–8. Restore into **scratch first** and validate,
then cut over. Note that cutover is scenario A and is **not currently proven**.

---

## E. Operational risks

| # | Risk | Assessment |
|---|---|---|
| 1 | `updatedAt` changes on repaired rows | **Accepted.** Nothing reads it; it is an honest audit trace. Documented, not hidden. |
| 2 | Historical notification snapshots | **No impact.** `NotificationOutbox.recipient` is frozen at send time and not written by the tool. History stays truthful. |
| 3 | Future WhatsApp / Qontak delivery | **Improved.** `normalizePhoneNumber()` becomes a no-op on the stored value. Landlines — which silently break WhatsApp — are quarantined, not sent. |
| 4 | Future courier shipments | **Improved.** `shipment.service.ts` reads `order.address.phone` dynamically, so bookings pick the canonical value up with no migration. |
| 5 | Addresses with existing orders | **Low.** No `Order.phone` column; the relation read resolves live. Verified end-to-end in dev on a row with an order and a shipment. |
| 6 | Malformed phones | **Open.** Never guessed. Requires a data owner. See below. |
| 7 | Duplicate phone numbers | **Low.** Normalisation *can* merge `08…`, `62…`, `+62…` into one value. There is **no unique index on `Address.phone`**, so a collision cannot fail the write. Production duplicate counts are **unmeasured**. |
| 8 | Concurrent address edits | **Mitigated** by CAS on the old value; a row edited mid-run aborts the whole transaction. |
| 9 | Concurrent backfill runs | **Mitigated** by the same CAS: the second run's updates miss and it aborts. Still, run once, with one operator. |
| 10 | Stale application instances | **No impact.** No phone value is cached in application memory; every read goes through the relation. |
| 11 | Cache / queue effects | **None.** The tool opens one database connection; it imports no HTTP, Redis or AMQP client. |
| 12 | Audit logging | **Gap.** The global `/admin` audit interceptor does not see a CLI tool. The run log plus the change ticket are the audit record — keep both. |
| 13 | Backup restore confidence | **Low — see section B.** F6 and H1 are open; cutover unproven. |

### Malformed rows

Never auto-repaired. For each, check `User.phone`, order history and outbox
references for a reliable source of truth:

- a reliable source exists → `REVIEWABLE`: a human confirms, then it joins the allowlist
- otherwise → `MANUAL_REVIEW`: leave it alone, escalate to the data owner

In shared dev exactly one such row exists (2 digits, contains letters, `User.phone`
null, zero orders). It has no source of truth and remains quarantined. **The
production count is unknown** until the section A audit runs.

---

## F. Open items blocking approval

1. Production audit not performed — DB unreachable from a workstation by design; must run on the production host.
2. Backup posture: **F6** (key not escrowed, restore scenario H unrecoverable) and **H1** (no off-server copy).
3. Restore scenario A (corrupted data → cutover) unproven — the exact path this change would need.
4. Production allowlist cannot exist until the audit produces candidate IDs.
5. Production approval mechanism (C.0) not implemented, by design.
6. Production duplicate-collision counts unmeasured.
7. Malformed-row count and disposition in production unknown.
