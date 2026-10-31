# JNE master import runbook

`import-jne-master.ts` is the only way a JNE master enters `JneLocation`. It reads a captured snapshot and never calls
JNE. It writes `JneLocation` only: mappings are never created, changed, retired or reactivated by this tool.

**What a tool allows is not an authorization.** Every write below needs owner approval for that exact operation. A test or
rehearsal approval, including any synthetic reviewer name, authorizes nothing in production.

**Business decision: production refreshes DESTINATION only.** The existing ORIGIN master is correct and stays as it is,
labelled SANDBOX. Do not fetch `getorigin` and do not import ORIGIN for this refresh. `--kind ORIGIN` remains in the tool
because the sandbox master uses it; it is not part of this procedure.

## Modes

| mode | flags | touches the database |
|---|---|---|
| Offline | none | no |
| Live dry run | `--live-dry-run --report-dir <new dir>` | reads, in a READ ONLY transaction |
| Import | `--confirm` plus every `--expect-*` | one serializable transaction |
| Deactivate missing | `--deactivate-missing <codes.csv>` | dry run unless `--confirm` |

`--override-row-count` is gone and refused. There is no sandbox row-count constant any more.

## What an import needs

1. A snapshot file, unchanged since capture, with `--metadata <fetch-metadata.json>` for PRODUCTION.
2. `--expect-records`, `--expect-unique-codes`, `--expect-sha256`: the values a person reviewed. JNE returns no total
   count or paging fields, so these are the completeness guard. HTTP 200 proves nothing here.
3. `--expect-plan`: the plan hash from the live dry run of the same state, so what is written is what was reviewed.
   It binds the snapshot, kind, source, fetch time, every planned row, the mappings, the ORIGIN fingerprint and the
   target environment, so a hash from a staging dry run is refused in production.
4. `--reviewed-renames <file.csv> --reviewed-by "<who>"` when a rename sits under an active MATCHED mapping.
5. For a PRODUCTION snapshot: `JNE_ENVIRONMENT=production`, and `JNE_BASE_URL` naming the endpoint in the metadata.
6. For DESTINATION from PRODUCTION: the configured `JNE_ORIGIN_CODE` present and active in the ORIGIN master, whatever
   its source. This is the condition the backend checks at boot.

## Blockers

| code | meaning | resolution |
|---|---|---|
| `INVALID_RECORDS`, `DUPLICATE_CODES` | a record fails validation; nothing is repaired | get a clean snapshot |
| `EXPECTED_VALUE_REQUIRED` | a write is missing a reviewed value | pass it |
| `RECORD_COUNT_MISMATCH`, `UNIQUE_CODE_COUNT_MISMATCH`, `CHECKSUM_MISMATCH` | not the reviewed snapshot | investigate; never adjust the number to fit |
| `PLAN_MISMATCH` | the master changed since review | re-run the dry run and review it |
| `FETCH_TIME_UNKNOWN` | no capture time | supply metadata; the import time is never recorded instead |
| `STALE_SNAPSHOT` | rows came from a newer capture | use the newer snapshot |
| `PROVENANCE_MISSING`, `PROVENANCE_INVALID` | the metadata does not back `--source` | use the real capture metadata |
| `TARGET_ENVIRONMENT_MISMATCH` | source and `JNE_ENVIRONMENT` disagree | run in the right environment |
| `SANDBOX_INTO_PRODUCTION_MASTER` | SANDBOX aimed at a master holding PRODUCTION rows | not allowed |
| `RENAME_NEEDS_REVIEW` | a name changes under an active MATCHED mapping | review, then list it exactly |
| `REVIEWED_RENAME_NOT_PENDING` | the review does not match the plan | redo the review |
| `MISSING_MATCHED_NEEDS_ACK` | a code absent from the snapshot still has an active MATCHED mapping | decide; see Missing destinations |
| `MISSING_ACK_INVALID` | an acknowledgment differs from the database or snapshot | rebuild it from `missing-matched.csv` |
| `MISSING_ACK_NOT_PENDING` | an acknowledgment matches nothing that is blocking | remove it: it is stale |
| `ORIGIN_CODE_UNKNOWN` | `JNE_ORIGIN_CODE` is not set | set it; the backend needs it too |
| `ORIGIN_CODE_NOT_ACTIVE` | the origin code is absent or inactive in the ORIGIN master | stop: the backend would not start |
| `ORIGIN_CODE_NOT_IN_SNAPSHOT` | only for `--kind ORIGIN`: the snapshot lacks the origin code | not part of the refresh |

Known test codes (`TEST`, `XXWWQEQ`) are excluded and listed. Any other malformed code refuses the snapshot.

## The write boundary

An import writes one kind. For `--kind DESTINATION` the ORIGIN master is a protected set:

- `plan.json` records `protectedRows` and `protectedFingerprint`, over every column of every ORIGIN row, and
  `protected-kind-snapshot.csv` holds those rows.
- The fingerprint is part of the plan hash, so a change to ORIGIN after review fails with `PLAN_MISMATCH`.
- Every update carries `kind` in its WHERE clause, and a short row count rolls back.
- The fingerprint is recomputed after the writes, inside the transaction. Any difference rolls back.

## Order for a production refresh

1. Deploy a build containing this tool. The steps below run where the production environment variables are set, for
   example `node dist/prisma/tools/import-jne-master.js` in a one-off container, with the snapshots mounted read-only.
2. Back up the production database.
3. DESTINATION: live dry run, review `missing.csv`, `mapping-impact.csv` and `renames-to-review.csv`, keep `plan.json`.
4. Import with the reviewed values.
5. Compare `protectedFingerprint` in the dry run and import reports, then check the backend starts.
6. Sample RATE through the normal flow.
7. Regenerate candidates from the production master and dry-run the manifest with `--allow-source PRODUCTION`.
8. Deactivate missing codes as a separate, reviewed step.

Import to production only. Staging runs sandbox credentials, so its master stays SANDBOX.

```bash
node dist/prisma/tools/import-jne-master.js --kind DESTINATION --source PRODUCTION \
  --snapshot /in/raw-getdestination.json --metadata /in/fetch-metadata.json \
  --live-dry-run --report-dir /out/destination-dry-run
```

```bash
node dist/prisma/tools/import-jne-master.js --kind DESTINATION --source PRODUCTION \
  --snapshot /in/raw-getdestination.json --metadata /in/fetch-metadata.json \
  --expect-records <n> --expect-unique-codes <n> --expect-sha256 <hex> --expect-plan <hex> \
  --reviewed-renames /in/reviewed-renames.csv --reviewed-by "<who>" \
  --report-dir /out/destination-import --confirm
```

A repeat run of an imported snapshot writes nothing and exits 0. PostgreSQL may abort the serializable transaction if a
concurrent write conflicts. Nothing is written in that case: re-run the dry run, then the import.

## Missing destinations with mappings

A code absent from the snapshot stays active, so an active MATCHED mapping on it keeps resolving: the district keeps
sending JNE a code JNE no longer lists. That now blocks the dry run and the import.

The dry run prints total missing codes, those with active MATCHED, those with REVIEW_REQUIRED, those with no active mapping,
acknowledgments accepted, and what is unresolved. `missing-matched.csv` lists each affected mapping.

Choose one for each row:

1. **Fix it:** map the district to the right code, or retire the mapping with `deactivate-jne-mappings.ts`. The blocker clears
   because no active MATCHED mapping remains.
2. **Accept it:** the owner accepts that the district keeps resolving this code for now, and records why.

To accept, copy the row from `missing-matched.csv` into a new CSV and fill `reviewer`, `reason` (at least 10 characters) and
`reviewed_at`. The columns are `mapping_id`, `district_code`, `jne_code`, `expected_raw_name`, `expected_status`,
`snapshot_sha256`, `reviewer`, `reason`, `reviewed_at`. Extra columns are ignored. Keep `expected_raw_name` exactly as written:
JNE names carry edge whitespace.

Run the dry run again with `--missing-acks <file.csv>`. Acknowledgments are part of the plan hash, so use the hash from that
dry run with `--expect-plan`, and pass the same file to the import.

An acknowledgment applies to one mapping, one name and one snapshot. It is refused if any field differs, and it goes stale when
the mapping is retired, the code returns, or the snapshot changes. It writes nothing: no mapping is retired or moved, no
location changes, and no rename is approved. There is no global bypass flag.

A REVIEW_REQUIRED mapping on a missing code is reported as a warning, because it does not resolve. Do not approve it as it stands.

Missing codes are never substituted automatically. A row with the same name under another code may be unrelated, so moving a
district to it is a reviewed remap: retire, manifest, approve.

## Missing codes

An import never deactivates anything. Between import and deactivation, missing codes stay active and labelled SANDBOX.
`--allow-source PRODUCTION` refuses them as new mapping targets, but the checkout resolver reads no source, so a mapping
on one would still resolve.

Deactivation takes an explicit list, a `code` column, usually a reviewed subset of `missing.csv`:

```bash
node dist/prisma/tools/import-jne-master.js --kind DESTINATION --source PRODUCTION \
  --snapshot /in/raw-getdestination.json --metadata /in/fetch-metadata.json \
  --deactivate-missing /in/reviewed-codes.csv --expect-count <n> \
  --reason "<why>" --operator "<who>" \
  --expect-records <n> --expect-unique-codes <n> --expect-sha256 <hex> \
  --report-dir /out/deactivate-dry-run
```

Add `--confirm` to a new `--report-dir` to write. All listed codes or none. It refuses a code that is in the snapshot,
already inactive, or carrying any active mapping: retire those with `deactivate-jne-mappings.ts` first. Rows are kept.

## Retired mappings

Retiring sets `isActive=false` and keeps the status, the JNE location and the review. A retired mapping stops resolving and does
not come back through an import, a snapshot, a manifest, the candidate generator, a matching code or a similar name. Only
`reactivate-jne-mappings.ts` restores it.

It changes `isActive` on the same row, and appends who, why and the state change to `notes`. The id, district, location, status,
method, evidence and original `reviewedBy`/`reviewedAt` stay.

1. Write the pairs to restore, with columns `district_code,jne_code`, and prepare a review file. This only reads.

```bash
node dist/prisma/tools/reactivate-jne-mappings.js --prepare <pairs.csv> --out <new-review.csv>
```

2. A reviewer checks every value and fills `reviewer`, `reason` (at least 10 characters) and `review_reference`.
3. Dry run. This prints each decision and the plan hash, and writes nothing.

```bash
node dist/prisma/tools/reactivate-jne-mappings.js --review-file <review.csv> --operator "<who>"
```

4. With owner approval for those exact rows, confirm:

```bash
node dist/prisma/tools/reactivate-jne-mappings.js --review-file <review.csv> --operator "<who>" --expect-count <n> --expect-plan <hex> --confirm
```

The whole file is refused if any row has a wrong id, district, code or status, a row version other than `expected_updated_at`,
a blank reviewer, reason or reference, or if the mapping is active, its location or district is inactive, or the district has
another active MATCHED or REVIEW_REQUIRED mapping. Each row is checked again inside one serializable transaction, and the partial
unique index refuses a second active MATCHED row. A repeat is refused, not skipped: the mapping is already active.

A reactivation does not check the latest snapshot. If the code is missing there, the next dry run blocks on it.

Reactivating changes mapping state, so a master import plan reviewed before it fails with `PLAN_MISMATCH`.

## `sourceFetchedAt`

It is the fetch time of the snapshot the row was last seen in. It is not the time the row's attributes last changed.

- A row in a newer snapshot gets the new time, changed or not, so one corrected name still updates every row in that snapshot.
- A row absent from the snapshot keeps its old time. That is how an old row can be told apart from a current one.
- `STALE_SNAPSHOT` compares this value to refuse an older capture.

The schema defines it as "when the snapshot this row came from was fetched". Only the importer reads it, and only the importer
writes it. No checkout, resolver or report treats it as a change date. To see when attributes changed, compare `changed.csv`
reports. This behaviour is covered by tests and must not change without a separate decision.

## Rollback and forward fix

- A table rollback is refused while any mapping, retired or not, points at a row added after the backup. Reactivating or
  retiring a mapping does not reopen it.
- A forward fix keeps ids and mappings, so retired mappings stay retired and acknowledged mappings stay as they are.
- An acknowledgment names one snapshot, so a restore or forward fix does not carry it over. Any later import needs a new dry run.

## Source and the other tools

- `generate-jne-mapping-candidates.ts` now requires `--source`.
- `resolveDistrictCandidate(s)` take a required `source` option.
- `import-jne-mapping-manifest.ts` already required `--allow-source`.
- The checkout resolver stays source-blind on purpose: a mapping's approval is what makes a code usable.

## Rollback

An import that fails leaves the master untouched. After a committed import, restore from the backup taken in step 3.
There is no reverse import, because a SANDBOX snapshot may not touch a PRODUCTION master.

## Proposal: import ledger (NOT a migration, not applied, not required)

No schema change is needed for this tool. `JneLocation.source` and `sourceFetchedAt` hold what the row needs, and
`plan.json` in the report directory holds the checksum, plan hash and metadata. That record lives on a disk, so it can
be lost. If it should live in the database, this adds one table. It belongs in `prisma/migrations` only after it is
approved, together with the code that writes it.

```sql
CREATE TABLE "JneMasterImport" (
  "id"              TEXT PRIMARY KEY,
  "kind"            "JneLocationKind" NOT NULL,
  "source"          "JneDataSource" NOT NULL,
  "snapshotSha256"  CHAR(64) NOT NULL,
  "planSha256"      CHAR(64) NOT NULL,
  "sourceFetchedAt" TIMESTAMP(3) NOT NULL,
  "records"         INTEGER NOT NULL,
  "uniqueCodes"     INTEGER NOT NULL,
  "created"         INTEGER NOT NULL,
  "updated"         INTEGER NOT NULL,
  "missing"         INTEGER NOT NULL,
  "reviewedBy"      TEXT,
  "provenance"      JSONB NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Additive and independent of the mapping tables; no existing row changes. The trade-off: every import gains one write
inside its transaction, and the table must be retained across restores.
