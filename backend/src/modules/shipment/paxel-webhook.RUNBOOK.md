# Paxel webhook — go-live runbook

Status of the implementation: **done and deployed OFF** (`PAXEL_WEBHOOK_ENABLED=false`).
Several protocol details are **not yet confirmed by Paxel** (section 3). Do not enable
the webhook in production until every item there is answered. Nothing here calls Paxel.

The tracking **poller** (`SHIPMENT_TRACKING_ENABLED`) keeps Paxel shipments moving
whether or not the webhook is on; the webhook only makes updates arrive sooner.

## 1. Endpoint to register with Paxel

| | |
|---|---|
| Method | `POST` |
| Content-Type | `application/json` (anything else is refused with HTTP 415) |
| URL | `<APP_URL>/api/v1/shipments/webhook/paxel` — the **public** production API origin (`APP_URL` in `production.env`). Never localhost or an internal address. |
| Authentication | `X-Paxel-Signature` header, verified in constant time with `PAXEL_WEBHOOK_SECRET` (see 3.A). The body's `signature` / `pdo_signature` / `photo` / `pdo_photo` fields are delivery media links, **not** authentication. |
| Rate limit | 600 requests/min per client IP on this route (the JNE webhook's arrangement). |

### Responses

HTTP codes are ours. The body is **not a Paxel contract** (Paxel's expected
acknowledgement is unconfirmed — 3.C); it follows this codebase's Midtrans receiver.

| HTTP | Body | Meaning |
|---|---|---|
| 200 | `{"received": true}` | Accepted: processed, recorded without a transition, or an already-processed duplicate |
| 400 | `{"received": false, "reason": "..."}` | Invalid payload (missing/invalid `airwaybill_code` or `latest_status`) |
| 401 | `{"received": false, "reason": "..."}` | `X-Paxel-Signature` missing or invalid — nothing is looked up or written |
| 404 | `{"received": false, "reason": "unknown airwaybill_code: ..."}` | No **Paxel** shipment has this AWB — nothing is created |
| 409 | `{"received": false, "reason": "..."}` | `invoice_number` present and not our order number; or the shipment changed mid-request (retry) |
| 415 | `{"received": false, "reason": "Content-Type must be application/json"}` | Not JSON |
| 503 | `{"received": false, "reason": "Paxel webhook is not enabled"}` | `PAXEL_WEBHOOK_ENABLED` is not `true` (or no secret configured) |
| 500 | `{"received": false, "reason": "internal error"}` | Unexpected failure; nothing was written, a retry is safe |

Known edge: a body that is not valid JSON, over ~100 KB, or rate-limited is answered by
the framework (`{"statusCode": ..., "message": ...}`).

## 2. Payload (from the one real Paxel example)

**Required** (400 when missing/blank/not a string): `airwaybill_code`, `latest_status`.
Both are also the signature inputs and are used exactly as sent.

**Supported, optional:** `invoice_number`, `cancellation_reason`, `delivery_datetime`,
`driver_name`, `receiver_name`, `sender_name`, `actual_price`, `actual_weight`,
`photo`, `signature`, `pdo_photo`, `pdo_signature`, `logs` (one object as in the
example; an array of such objects is tolerated) with `address`, `city`,
`created_datetime`, `district`, `latitude`, `longitude`, `name`, `note`, `province`,
`status`; `money` with `bill_note`, `collect_money`; `items[]` with `code`, `name`,
`category`, `special_insurance`.

- An optional field with an unusable value is **dropped** (its name is logged, never its
  value); the push is still processed. Unknown extra fields are accepted and not stored.
- Numbers are kept exactly as sent (raw string + value). **No unit is assumed or converted**
  for `actual_price`, `actual_weight`, `money.collect_money`.
- `delivery_datetime` and `logs.created_datetime` are stored **verbatim**; no time zone is
  assumed. Paxel log times are compared only with each other (stale-push protection).
- Media fields are stored only when they are absolute `http(s)` links — **never fetched,
  never proxied**. Anything else is dropped.
- `money` is courier information only; it never touches payment or order state.
- `actual_price` never replaces `Shipment.cost` (what the customer was charged).

### Matching rules

- `airwaybill_code` must be the AWB of an existing **Paxel** shipment. Another courier's
  shipment is never touched (404).
- `invoice_number`: we book Paxel with `invoice_number` = our order number
  (`BMS-...`). When a push carries it, it must match (409 otherwise). When absent it is
  not required.

### What each status does (the shared Paxel vocabulary, unchanged)

| Paxel `latest_status` | Shipment | Order | Customer WhatsApp |
|---|---|---|---|
| CONFIRMED | CREATED | SHIPPED | yes |
| RTP, COL | WAITING_PICKUP | SHIPPED | no |
| PAPV | PICKED_UP | DELIVERING | yes |
| POL | IN_TRANSIT | DELIVERING | yes |
| POD, COD | OUT_FOR_DELIVERY | DELIVERING | yes |
| PDO | DELIVERED (terminal) | DELIVERED | yes |
| PRJL, RAP, UNDLM, RTN | FAILED (terminal) | unchanged | yes ("gagal dikirim") |
| CCS | CANCELLED (terminal) | CANCELLED | yes |
| HAPH, FAILED3PL, ONHOLD3PL, ODL, ODLXL, POLXL, any other code | no change — recorded, warning logged | unchanged | no |

Order moves follow the legal order transitions (a CANCELLED/COMPLETED order is never
revived). Transitions are forward-only; terminal shipments never change; an older or
duplicate push never regresses or repeats anything.

## 3. Paxel confirmation items — must be answered before enabling

| # | Question | How to verify | If the answer differs |
|---|---|---|---|
| A | Exact `X-Paxel-Signature` algorithm for webhooks, and **which secret** signs it | Paxel's written spec + one real signed push; compare with `paxelWebhookSignature()` = `SHA256(airwaybill_code[-6:] + latest_status[:2] + secret)` (hex) | Every push is refused 401 (fail closed). Adjust only `verifyPaxelWebhookSignature` / the helper, with the real example pinned as a test vector |
| B | Header format (hex case, any prefix) | Same real push | Same as A |
| C | Acknowledgement Paxel expects (HTTP status, body) | Paxel spec | Change only the response body in `PaxelWebhookService` |
| D | Retry behaviour on 2xx / 4xx / 5xx | Ask Paxel | A 4xx is permanent for us; a 500 is safe to retry. If Paxel never retries, the poller is the backstop |
| E | Source IP addresses | Paxel in writing | Configure the reverse-proxy restriction (section 4) |
| F | Does `invoice_number` echo our booking value verbatim? | Real push for a shipment we booked | Pushes are refused 409; the matching rule must change |
| G | Units of `actual_price`, `actual_weight`, `money.collect_money`; meaning of `money` | Paxel spec | Stored raw either way; only interpretation is affected |
| H | Time zone and meaning of `delivery_datetime` and `logs.created_datetime`; can `logs` be an array? | Paxel spec / real pushes | Stored verbatim either way. `logs.created_datetime` of the entry matching `latest_status` is used only to refuse OLDER pushes |
| I | Are `photo` / `signature` / `pdo_photo` / `pdo_signature` URLs? | Real push | Non-URL values are dropped today |
| J | Meaning of HAPH, FAILED3PL, ONHOLD3PL, ODL, ODLXL, POLXL | Paxel spec | They stay recorded-only until mapped in `shipment-status.mapper.ts` (affects the poller too) |
| K | How the webhook URL is registered (per account / per shipment / per environment) | Paxel | Registration procedure only |

## 4. Reverse proxy / network (production action)

This repository contains no reverse-proxy configuration. When Paxel provides its
source IPs, configure the proxy to allow `POST /api/v1/shipments/webhook/paxel` only
from those addresses, keep appending `X-Forwarded-For` (`TRUST_PROXY_HOPS=1`), and pass
the path, headers and JSON body through unmodified. Application checks (flag, content
type, signature, AWB/provider match, forward-only transitions) stay active regardless.

## 5. Go-live sequence

1. Deploy with `PAXEL_WEBHOOK_ENABLED=false`.
2. Obtain answers to section 3 (A, C, E and F at minimum) and one **real signed push**.
3. Add that push as a test vector; adjust verification only if Paxel's spec requires it.
4. On **staging**: set `PAXEL_WEBHOOK_ENABLED=true` and `PAXEL_WEBHOOK_SECRET=<from Paxel>`,
   register the staging URL, and have Paxel send test pushes for a staging booking
   (staging forces the notification allowlist, so no real customer is messaged).
5. Verify: status, `ShipmentHistory`, `metadata.paxel.webhook` (observations, logs,
   actuals, media links), order status, one `shipment.status` notification row.
6. Re-send the same push: expect 200 and no new history/notification.
7. Only then: set both variables in `production.env`, configure the proxy restriction,
   register the production URL, and
   `docker compose --env-file ./production.env -f docker-compose.production.yml up -d --force-recreate backend`.

**Rollback:** set `PAXEL_WEBHOOK_ENABLED=false` and recreate the backend. The endpoint
answers 503; the poller keeps shipments moving.

## 6. Monitoring

Admin → System → Logs, module `shipment.webhook`, actions `paxel.*`:

| Action | Meaning | Watch for |
|---|---|---|
| `paxel.transitioned` | shipment moved | normal |
| `paxel.recorded` | new information stored, no transition (stale, terminal, same state) | normal |
| `paxel.duplicate` | retry of an already-processed push | expected |
| `paxel.unmapped_status` | undocumented code recorded, no transition | needs an operator's attention (item J) |
| `paxel.signature_missing` / `paxel.signature_invalid` | 401 | **any** from Paxel → item A/B |
| `paxel.validation_failed` | 400 | **any** → Paxel's real payload differs |
| `paxel.invoice_mismatch` | 409 | **any** → item F |
| `paxel.unknown_shipment` | 404 | AWBs not booked by this shop |
| `paxel.failed` | 500 | database/infra problem |

The request signature is never logged (it is redacted from request logs) and never stored.
