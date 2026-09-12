# JNE Webhook Status V2 — go-live runbook

Status of the implementation: **done and deployed OFF** (`JNE_WEBHOOK_ENABLED=false`).
This runbook is everything needed to switch it on safely. Nothing here calls JNE.

## 1. Endpoint to register with JNE

| | |
|---|---|
| Method | `POST` |
| Content-Type | `application/json` (anything else is refused with HTTP 415) |
| URL | `<APP_URL>/api/v1/shipments/webhook/jne` — the **public** production API origin (`APP_URL` in `production.env`). Never localhost or an internal address. |
| Authentication | **None.** JNE's V2 documentation defines none, and none is invented. Protection is the reverse-proxy IP restriction (section 4) plus application checks. |

### Responses (JNE's documented bodies; HTTP codes are ours)

| HTTP | Body | Meaning |
|---|---|---|
| 200 | `{"status": true}` | Accepted: processed, recorded without a transition, or an already-processed duplicate |
| 400 | `{"status": false, "reason": "..."}` | Invalid payload (missing mandatory field, undocumented status, bad `history[].date`, non-numeric weight/ongkir) |
| 404 | `{"status": false, "reason": "unknown awb: ..."}` | No JNE shipment has this AWB — nothing is created |
| 409 | `{"status": false, "reason": "order_id does not match ..."}` | `order_id` is not the order number of the AWB's shipment |
| 415 | `{"status": false, "reason": "Content-Type must be application/json"}` | Not JSON |
| 503 | `{"status": false, "reason": "JNE webhook is not enabled"}` | `JNE_WEBHOOK_ENABLED` is not `true` |
| 500 | `{"status": false, "reason": "internal error"}` | Unexpected failure; nothing was written, a retry is safe |

Known edge: a body that is not valid JSON, a body over ~100 KB, or a rate-limited request is answered by
the framework in the application's generic error shape (`{"statusCode": ..., "message": ...}`), not
JNE's. A legitimate JNE push never hits these.

## 2. Payload JNE must send (JNE V2 documentation)

**Mandatory** (a missing/blank one is rejected with 400):
`awb`, `order_id`, `status`, `actual_weight`, `actual_ongkir`, `service`, `actual_sender_name`,
`actual_sender_address`, `goods_desc`, `origin_code`, `dest_code`.

**Optional:** `actual_receiver_address`, `actual_receiver_city_name`, `actual_receiver_city_code`,
`latitude`, `longitude`, `history[]`.

**DELIVERED only:** `signature`, `photo`, `receiver_name`, `receiver_relation`, `cod_amount`.
Absent on other statuses is normal; if sent on other statuses they are ignored.

**`history[]` entries:** `date` (`YYYY-MM-DD HH:MM:SS`, required per entry), `status`,
`status_code`, `status_desc`, `location_code`.

**`status`** — exactly one of the six documented summary statuses:
`SUCCESS PICKUP`, `FAILED PICKUP`, `SHIPPED`, `DELIVERED`, `SHIPMENT PROBLEM`, `RETURN TO SHIPPER`.

### Matching rules

- `awb` must be the AWB (cnote) of an existing **JNE** shipment in our database.
- `order_id` must equal the order number we sent JNE as **`order_no`** when booking
  (`BMS-YYYYMMDD-XXXXXXXX`). A mismatch is refused, never corrected.
- `signature` and `photo` are the recipient's signature image and delivery photo **URLs**
  (stored as links, never downloaded). They are **not** webhook authentication.

### What each status does

| JNE status | Shipment | Order | Customer WhatsApp |
|---|---|---|---|
| SUCCESS PICKUP | PICKED_UP | DELIVERING | yes |
| SHIPPED | IN_TRANSIT | DELIVERING | yes |
| DELIVERED | DELIVERED (terminal) | DELIVERED | yes |
| RETURN TO SHIPPER | FAILED (terminal) | unchanged | yes ("gagal dikirim") |
| FAILED PICKUP | no change — recorded, warning logged | unchanged | no |
| SHIPMENT PROBLEM | no change — recorded, warning logged | unchanged | no |

Transitions are forward-only; an older or duplicate push never regresses or repeats anything.

## 3. JNE confirmation items — must be answered from a real JNE test push

None of these can be derived from the documentation. **Do not assume an answer.**

| # | Question | How to verify | If the answer differs |
|---|---|---|---|
| A | Does JNE send back our booking `order_no` as `order_id`? | Test push for a shipment we booked; response 200, not 409 | Every push would be refused (409); the matching rule must change before go-live |
| B | Exact format of `actual_weight`, `actual_ongkir`, `cod_amount` | Inspect the stored `metadata.jne.webhook.actual` / `.delivery` (raw strings are kept) | We accept dot-decimals only (`1.2`, `21000`, `21000.00`). A comma decimal (`1,5`) is refused (400); an Indonesian thousands separator (`10.000`) would be read as 10 |
| C | Time zone of `history[].date` | Compare a push's dates with JNE's tracking page / known event times | Dates are stored verbatim and only compared with each other; only the meaning shown to operators is affected |
| D | Exact tracking `pod_status` values for failed pickup, shipment problem, returned, delivered, other terminal failures | JNE tracking-API documentation or sandbox captures | The tracking **poller** still maps generic `FAILED`/`RETURNED`/`UNDELIVERED` to terminal FAILED; only with these values can it match the webhook's record-only FAILED PICKUP (see `shipment-status.mapper.ts`) |
| E | JNE retry behaviour on 200 `{"status":true}`, 4xx and 5xx | Ask JNE; observe retries on a deliberate 404/409 | A 4xx is permanent for us (bad data); a 500 is safe to retry. If JNE never retries, a 500 loses that push — the poller remains the backstop |

## 4. Reverse proxy / network (production action)

This repository contains **no reverse-proxy configuration** (`docker-compose.production.yml` leaves TLS and
the proxy to the edge layer). The backend publishes no host port and is reachable only through the proxy
on the `edge` network. When JNE provides its source IP addresses, configure the proxy to:

1. Allow `POST /api/v1/shipments/webhook/jne` **only** from the JNE-provided addresses; refuse everyone else
   for that path. Do not add addresses JNE has not provided in writing.
2. Keep forwarding the client address by **appending** `X-Forwarded-For` (production runs
   `TRUST_PROXY_HOPS=1`), so the application's per-IP rate limit (600/min on this route) keys on JNE's
   address, not the proxy's.
3. Pass the path and JSON body through unmodified; no caching.

Application validation stays fully active behind the restriction: the enabled flag, content type, payload
validation, AWB + `order_id` matching and forward-only transitions do not depend on the proxy.

## 5. Go-live sequence

1. Deploy the backend with the webhook implementation.
2. Keep `JNE_WEBHOOK_ENABLED=false`.
3. When JNE provides source IPs, configure the reverse-proxy restriction (section 4).
4. Register `<APP_URL>/api/v1/shipments/webhook/jne` with JNE.
5. Ask JNE for a sandbox/test push. **With the flag off, production answers 503 by design**, so run the
   test where the flag is on:
   - preferably a **staging** deployment with `JNE_WEBHOOK_ENABLED=true` and JNE sandbox bookings
     (staging forces the notification allowlist, so no real customer is messaged); or
   - a short, IP-restricted production window using a **dedicated internal test order** (never a real
     customer's AWB: a transition sends that customer a WhatsApp).
6. Answer every item in section 3 (`order_id`, number formats, time zone, tracking vocabulary, retries).
7. Verify database effects for the test shipment: status, `ShipmentHistory`, `metadata.jne.webhook`
   (events, actual weight/ongkir, delivery fields), order status, one `shipment.status` notification row.
8. Re-send the same push: expect 200 and no new history/notification (idempotency).
9. Only after 5–8 succeed: set `JNE_WEBHOOK_ENABLED=true` in `production.env` and
   `docker compose --env-file ./production.env -f docker-compose.production.yml up -d --force-recreate backend`.
10. Monitor the first production events (section 6).

**Rollback:** set `JNE_WEBHOOK_ENABLED=false` and recreate the backend. The endpoint answers 503; the tracking
poller keeps shipments moving.

## 6. Monitoring

Admin → System → Logs, module `shipment.webhook` (the detail view shows AWB, JNE `order_id`, status,
transition). Container logs: `docker compose ... logs backend | grep jne.webhook`.

| Action / event | Meaning | Watch for |
|---|---|---|
| `jne.webhook.received` | push arrived | volume matches JNE activity |
| `jne.transitioned` | shipment moved (history row + one notification) | normal |
| `jne.recorded` | new events/figures stored, no transition (stale, terminal, same state) | normal |
| `jne.duplicate` | retry of an already-processed push | expected; no side effects |
| `jne.validation_failed` | 400 | **any** → JNE's real format differs (section 3 B) |
| `jne.order_mismatch` | 409 | **any** → section 3 A, or a manually booked legacy shipment |
| `jne.unknown_shipment` | 404 | AWBs not booked by this shop |
| `jne.failed` | 500 | database/infra problem; JNE should retry |
| `jne.failed_pickup`, `jne.shipment_problem` | recorded, no transition | needs an operator's attention |

Note: the log search box matches messages and ids, not the AWB; filter by module and open the entry.
Poller refusals of stale answers are kept in `Shipment.metadata.tracking.rejected`.
