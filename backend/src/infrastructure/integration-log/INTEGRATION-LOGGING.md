# Integration API Logging (P1)

Durable, queryable records of every external API exchange with **Paxel**, **JNE** and
**Midtrans**, so a provider failure can be diagnosed from the Admin panel instead of
from container logs that have already rotated away.

The motivating case: JNE answers `POST /tracing/api/generatecnote` with **HTTP 200**
and no cnote. Before this feature the response body was never stored anywhere, so
`JNE did not return a cnote (unknown)` was the entire evidence trail.

## What is recorded

| Record | When | `attempt` |
|---|---|---|
| `HTTP_ATTEMPT` | every ACTUAL outbound HTTP attempt, including each retry | 1, 2, … |
| application outcome | when a provider answer still has to be interpreted (JNE cnote parsing, a Midtrans body rejection, a 2xx that is not JSON) | `null` |
| `WEBHOOK` | every inbound webhook request | `null` |

Every record of one logical call shares an **`operationId`**, so the Admin UI groups
attempts and their outcome into a single call. `GET /admin/integration-logs/operations/:operationId`
returns exactly that group.

### Retries

**One record per actual HTTP attempt** (decision: option B). `500 → 200` is two rows,
same `operationId`, `attempt` 1 and 2, with the real status on each. Retry semantics
themselves are untouched: the transports decide what to repeat exactly as before.

## Schema

`IntegrationApiLog` (see `prisma/schema.prisma`), indexed on `createdAt`,
`(provider, createdAt)`, `(operation, createdAt)`, `(applicationOutcome, createdAt)`,
`(httpStatus, createdAt)`, `operationId`, `orderId`, `paymentId`, `shipmentId`,
`requestId`.

Deliberately **not** `SystemLog`: the Performance Profiler aggregates every SystemLog
row with a non-null `durationMs` and no module filter, so provider latencies would
corrupt the request percentiles an existing admin page reports.

### Vocabulary

Each provider keeps its own words — nothing is renamed for cosmetic consistency:

| Provider | Operations |
|---|---|
| `PAXEL` | `RATE`, `CREATE_SHIPMENT`, `CANCEL`, `TRACK`, `WEBHOOK` |
| `JNE` | `RATE`, `PICKUP_CASHLESS`, `CANCEL_CNOTE`, `TRACK`, `WEBHOOK` (`GENERATE_CNOTE` on historical records only) |
| `MIDTRANS` | `charge`, `status`, `cancel`, `expire`, `WEBHOOK` |

JNE booking (`PICKUP_CASHLESS`) writes the HTTP attempt plus an application-outcome
record interpreting JNE's body against the confirmed contract: `OK` (`detail[0].status`
is success with a `cnote_no`), `REJECTED` (HTTP 200 carrying a JNE refusal, with its
`reason` as `errorMessage`) or `PARSE_FAILED` (anything else).

`applicationOutcome` is `OK`, `HTTP_ERROR`, `NETWORK_ERROR`, `TIMEOUT`,
`PARSE_FAILED` or `REJECTED`. `errorClass` keeps the transports' existing
classification words (`network`, `timeout`, `rate_limited`, `provider_5xx`,
`permanent_4xx`, `permanent`, `gateway_5xx`, `transient_exhausted`, `parse_failed`,
`rejected`).

## Redaction policy

`integration-log.sanitizer.ts` is the single sanitizer, reusing
`common/logging/redact.ts` so the codebase has one redaction vocabulary.

1. **Headers are never captured.** That removes the Paxel `X-Paxel-API-Key`, the
   Midtrans `Authorization: Basic`, cookies and `X-Paxel-Signature` by construction.
2. **Credential-looking keys are replaced at any depth**: `password`, `secret`,
   `api_key`/`apiKey`, `username`, `authorization`, `access_token`, `refresh_token`,
   `token`, `cookie`/`set-cookie`, `server_key`/`serverKey`, `webhook_secret`,
   `signature`/`signature_key`, `client_secret`, `pin`, `otp`, `cvv`, card numbers.
   **JNE matters most here**: it authenticates with `username` and `api_key` as
   *form fields*, so a form body is parsed into fields before sanitization.
3. **Unnecessary PII is replaced**: recipient/sender name, phone, email, address,
   and free-text delivery notes. Kept, because a failure is diagnosed from them:
   order number, ids, postal code, destination code, service, weight, amount,
   provider status, cnote/AWB.
4. Remaining strings are scrubbed of JWT-shaped substrings and capped
   (`INTEGRATION_LOG_MAX_STRING`, default 2 000 characters).
5. The payload is capped (`INTEGRATION_LOG_MAX_BYTES`, default 16 KB); over the cap
   it is replaced by `{ truncated: true, marker: "[TRUNCATED]", bytes, limitBytes, preview }`.

Endpoints pass through `redactSensitivePath`, so capability tokens in paths and
credential query values never land in the `endpoint` column.

## Reliability

`IntegrationLogService.record()` is fire-and-forget: it never awaits, swallows every
error, and reports a failure only as an `integration_log.persist_failed` line through
the existing Pino logger. Both transports additionally wrap the recorder call, so
even a broken recorder cannot fail a payment, a booking, a quote or a webhook.
`INTEGRATION_LOG_ENABLED=false` disables persistence entirely.

## Retention

Two policies inside the **existing** `RetentionWorker` (no second deletion
mechanism), batched and dry-run aware like every other policy:

| Policy | Matches | Default window |
|---|---|---|
| `IntegrationApiLog.volatile` | `applicationOutcome = OK` AND operation in `RATE`, `QUOTE`, `TRACK` | 14 days (`RETENTION_INTEGRATION_LOG_VOLATILE_DAYS`) |
| `IntegrationApiLog.durable` | everything else — bookings, cancellations, payment calls, webhooks, and **every failure** | 90 days (`RETENTION_INTEGRATION_LOG_DURABLE_DAYS`) |

The two predicates partition the table, so no row is matched twice or missed.

## Admin access

`GET /api/v1/admin/integration-logs` (plus `/:id` and `/operations/:operationId`),
behind `AdminGuard + PermissionGuard` and the dedicated **`IntegrationLog.read`**
permission. That permission is in the canonical catalogue and granted to **no role**
in the matrix, which makes it SUPER_ADMIN-only — the same treatment `SystemLog.read`
has. Granting it to ADMIN later is a matrix change plus a `sync-rbac` run.

Filters: `provider`, `operation`, `direction`, `applicationOutcome`, `httpStatus`,
`operationId`, `requestId`, `orderId`, `paymentId`, `shipmentId`, `dateFrom`,
`dateTo`, `search`, `page`, `limit`, `sort`. Newest first; the response uses the
repository envelope `{ items, page, limit, total, totalPages }`.

UI: **Admin → System → Integration Logs**, a filter row, a table
(Time / Provider / Operation / Direction / HTTP / Duration / Order / Outcome) and a
detail drawer with request, response and context. Payloads are collapsed by default.

## Troubleshooting a provider failure

1. Open **System → Integration Logs** and filter by the order number (`search`).
2. Read the rows newest-first: each outbound attempt, then the application outcome.
3. A `PARSE_FAILED` row carries the provider's actual (sanitized) answer — for the
   JNE case, whatever came back instead of a cnote.
4. `NETWORK_ERROR` / `TIMEOUT` rows mean the call never got an answer; the
   `attempt` / `maxAttempts` columns show how often it was retried.
5. `REJECTED` means the provider answered but refused the operation (a Midtrans
   `status_code` rejection, a webhook that failed verification).
6. Use `operationId` to see one logical call whole, or `requestId` to line it up
   with the SystemLog request timeline in **System → Request Explorer**.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `INTEGRATION_LOG_ENABLED` | `true` | Master switch for persistence |
| `INTEGRATION_LOG_MAX_BYTES` | `16384` | Payload size cap |
| `INTEGRATION_LOG_MAX_STRING` | `2000` | Per-string cap |
| `INTEGRATION_LOG_MAX_DEPTH` | `8` | Recursion depth before summarizing |
| `INTEGRATION_LOG_MAX_ARRAY_ITEMS` | `50` | Array items kept |
| `RETENTION_INTEGRATION_LOG_VOLATILE_DAYS` | `14` | Successful RATE/QUOTE/TRACK window |
| `RETENTION_INTEGRATION_LOG_DURABLE_DAYS` | `90` | Everything else |
