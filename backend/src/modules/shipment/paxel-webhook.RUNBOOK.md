# Paxel webhook — go-live runbook

Status of the implementation: **done**; it is switched per environment by
`PAXEL_WEBHOOK_ENABLED`. Paxel has confirmed most protocol details in writing (section 3).
Still open: the signature spec (3.A/3.B) and the meaning of FAILED3PL and ONHOLD3PL (3.J).
Nothing here calls Paxel.

The tracking **poller** (`SHIPMENT_TRACKING_ENABLED`) keeps Paxel shipments moving
whether or not the webhook is on; the webhook only makes updates arrive sooner.

## 1. Endpoint to register with Paxel

| | |
|---|---|
| Method | `POST` |
| Content-Type | `application/json` (anything else is refused with HTTP 415) |
| URL | `<APP_URL>/api/v1/shipments/webhook/paxel` — the **public** production API origin (`APP_URL` in `production.env`). Never localhost or an internal address. |
| Authentication | `X-Paxel-Signature` header, verified in constant time with `PAXEL_WEBHOOK_SECRET` (see 3.A). The body's `signature` / `pdo_signature` / `photo` / `pdo_photo` fields are delivery media links, **not** authentication. |
| Source IP (edge) | Allowlisted at nginx, per environment — see section 4. Defense in depth only: the signature is still verified on every request. |
| Rate limit | 600 requests/min per client IP on this route (the JNE webhook's arrangement). |
| Registration | Per **Corporate Account**, not per shipment. Production: the customer information is given to Paxel's **Sales Team**, who enter the webhook in **Paxel CMS Production**. |

### Responses

**Confirmed by Paxel:** the acknowledgement Paxel expects is **HTTP 200**. On **any other
status Paxel retries, up to 3 times.** The body is not part of Paxel's contract; it follows
this codebase's Midtrans receiver. Every replay of an already-processed push answers 200,
so a retry never repeats a transition, history row or notification. The non-200 answers
below are either genuinely invalid (a retry is harmless) or worth retrying (404 while a
booking is still committing, 409 shipment changed, 500).

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
- Numbers are kept exactly as sent (raw string + value), never converted. **Confirmed
  units:** `actual_weight` is in **grams**, `actual_price` in **Rupiah**. The unit of
  `money.collect_money` is still unconfirmed.
- **Confirmed:** `delivery_datetime` and `logs.created_datetime` are **WIB (Asia/Jakarta)**.
  They are stored verbatim (never reinterpreted as UTC) and Paxel log times are compared
  only with each other (stale-push protection), which is valid because they share one zone.
- **Confirmed:** `photo`, `signature`, `pdo_photo` and `pdo_signature` are always **URLs**.
  They are stored only when they are absolute `http(s)` links — **never fetched, never
  proxied**. Anything else is dropped.
- `money` is courier information only; it never touches payment or order state.
- `actual_price` never replaces `Shipment.cost` (what the customer was charged).

### Matching rules

- `airwaybill_code` must be the AWB of an existing **Paxel** shipment. Another courier's
  shipment is never touched (404).
- `invoice_number`: we book Paxel with `invoice_number` = our order number
  (`BMS-...`). **Confirmed by Paxel:** it is always the order/invoice number we sent. When a
  push carries it, it must match (409 otherwise). When absent it is not required (Paxel
  confirmed the value, not that it is always present).

### What each status does (the shared Paxel vocabulary, unchanged)

| Paxel `latest_status` | Shipment | Order | Customer WhatsApp |
|---|---|---|---|
| CONFIRMED | CREATED | SHIPPED | yes |
| RTP — *Shipment successfully created* | CREATED | SHIPPED | yes (none if already CREATED) |
| COL — *Courier has arrived at pickup location* | WAITING_PICKUP | SHIPPED | no |
| PAPV — *Courier has picked up your shipment* | PICKED_UP | DELIVERING | yes |
| POLXL — *Package on Origin Locker* | IN_TRANSIT | DELIVERING | yes |
| HAPH — *Hold at Paxel Home* | IN_TRANSIT | DELIVERING | yes |
| ODLXL — *Package on Destination Locker* | IN_TRANSIT | DELIVERING | yes |
| POL | IN_TRANSIT | DELIVERING | yes |
| COD — *Courier has arrived at destination* | OUT_FOR_DELIVERY | DELIVERING | yes |
| ODL — *On Delivery* | OUT_FOR_DELIVERY | DELIVERING | yes |
| POD | OUT_FOR_DELIVERY | DELIVERING | yes |
| PDO — *Delivery is Completed* | DELIVERED (terminal) | DELIVERED | yes |
| PRJL — *Pickup cancelled by courier* | FAILED (terminal) | unchanged (never CANCELLED) | yes ("gagal dikirim") |
| RAP, UNDLM, RTN | FAILED (terminal) | unchanged | yes ("gagal dikirim") |
| CCS | CANCELLED (terminal) | CANCELLED | yes |
| FAILED3PL, ONHOLD3PL, any other code | no change — recorded, warning logged (AS-IS) | unchanged | no |

Descriptions in *italics* are Paxel's own definitions (API documentation, **Webhook >
Shipment Status Mapping**). They map onto the existing lifecycle only: the locker and
Paxel Home states hold the parcel inside Paxel's network after pickup (IN_TRANSIT — never
DELIVERED, and not yet OUT_FOR_DELIVERY); PRJL is FAILED rather than CANCELLED because a
courier cancelling the pickup must not cancel the customer's order (FAILED keeps it and
leaves the shipment re-bookable). Every mapping is shared with the tracking poller
(`shipment-status.mapper.ts`).

**AS-IS, meaning not confirmed by Paxel:** FAILED3PL and ONHOLD3PL. They stay
record-only; they are never mapped from their literal words (item 3.J).

Order moves follow the legal order transitions (a CANCELLED/COMPLETED order is never
revived). Transitions are forward-only; terminal shipments never change; an older or
duplicate push never regresses or repeats anything.

## 3. Paxel confirmation items

Paxel's written clarifications closed most items. **Open** items must still be answered
before relying on the behaviour they describe.

| # | Question | Status | Answer / what to do |
|---|---|---|---|
| A | Exact `X-Paxel-Signature` algorithm for webhooks, and **which secret** signs it | **Open** | Verify with Paxel's written spec + one real signed push; compare with `paxelWebhookSignature()` = `SHA256(airwaybill_code[-6:] + latest_status[:2] + secret)` (hex). If it differs every push is refused 401 (fail closed); adjust only `verifyPaxelWebhookSignature` with the real example pinned as a test vector |
| B | Header format (hex case, any prefix) | **Open** | Same as A |
| C | Acknowledgement Paxel expects | **Closed** | HTTP **200**. The body is ours |
| D | Retry behaviour | **Closed** | Any non-200 → Paxel retries **up to 3 times**. Replays of processed pushes answer 200. Still unknown: the retry interval, and whether the 3 include the first attempt |
| E | Source IP addresses | **Closed** | Non-production **34.85.159.153**; production **34.126.76.148** (section 4) |
| F | Does `invoice_number` echo our booking value? | **Closed** | Always the order/invoice number Mas Sular sent |
| G | Units | **Closed** (partly) | `actual_weight` = grams, `actual_price` = Rupiah. `money.collect_money` unit and the meaning of `money` remain unconfirmed (stored raw, never used for payment) |
| H | Time zone of `delivery_datetime` / `logs.created_datetime` | **Closed** (partly) | Both **WIB / Asia/Jakarta**. Whether `logs` can be an array is unconfirmed (an array is tolerated) |
| I | Are `photo` / `signature` / `pdo_photo` / `pdo_signature` URLs? | **Closed** | Always URLs |
| J | Meaning of HAPH, FAILED3PL, ONHOLD3PL, ODL, ODLXL, POLXL | **Closed** for HAPH, ODL, ODLXL, POLXL (and RTP, COL, PAPV, COD, PDO, PRJL): mapped from Paxel's **Webhook > Shipment Status Mapping** definitions (section 2). **Open — AS-IS** for FAILED3PL and ONHOLD3PL | FAILED3PL and ONHOLD3PL stay recorded-only in `shipment-status.mapper.ts` (affects the poller too) until Paxel confirms their meaning. Do not invent mappings |
| K | How the webhook URL is registered | **Closed** | Per **Corporate Account**, not per shipment. Production: customer information goes to Paxel's **Sales Team**, who enter it in **Paxel CMS Production** |

Pricing note (not a webhook item): the Paxel **staging** account returns **dummy** rates
(e.g. `fixed_price` 106000 with `fixed_price_type: "dimension"`, `fixed_size: "custom"`).
Staging prices never represent production. Quotes always come from the live Paxel response
of the environment's own account; no Paxel price is hardcoded or stored as a rule.

## 4. Reverse proxy / network

The route is allowlisted **at nginx per environment**, on top of the application checks
(flag, content type, `X-Paxel-Signature` HMAC, AWB/provider match, forward-only
transitions), which stay active regardless. The allowlist is **not authentication**; never
remove or weaken the signature check because of it. A request from any other address gets
nginx's `403` and never reaches the backend or the integration log.

> **TEMPORARY — staging and production coexist on this VPS.** Until staging is retired,
> this VPS's nginx (`ops/nginx/mas-sular.conf`) accepts **both** official Paxel source IPs
> on this route: `34.85.159.153` (non-production) and `34.126.76.148` (production). Every
> other address is denied. Signature verification is unchanged and still decides whether a
> push is accepted.
>
> **Cleanup when staging is retired:** remove `allow 34.85.159.153;` from the location and
> keep only `allow 34.126.76.148;`, then `nginx -t` and reload. Also update
> `test/unit/paxel-webhook-edge.spec.ts`, which pins the temporary dual allowlist.

**This VPS** (`ops/nginx/mas-sular.conf`, API server block) — in place, TEMPORARY:

```nginx
location = /api/v1/shipments/webhook/paxel {
    allow 34.85.159.153;   # TEMPORARY: non-production (remove when staging is retired)
    allow 34.126.76.148;   # production
    deny all;
    # ... proxy to backend:3001 as the other API locations
}
```

Once staging is retired (or on a dedicated production proxy), each environment allows
**only its own** Paxel address.

**Production (final state)** — the target once staging is retired, or for a dedicated
production proxy. Its API server block needs exactly:

```nginx
location = /api/v1/shipments/webhook/paxel {
    allow 34.126.76.148;
    deny all;

    set $ms_upstream http://backend:3001;
    proxy_pass $ms_upstream;
    proxy_http_version 1.1;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Production must **not** allow `34.85.159.153` once staging is gone (the temporary exception
above is the only documented reason). Keep appending `X-Forwarded-For`
(`TRUST_PROXY_HOPS=1`) and pass the path, headers and JSON body through unmodified. Validate
with `nginx -t` before reloading. Manual test pushes from other addresses are refused at the
edge by design; test through Paxel or against a local backend.

## 5. Go-live sequence

1. Deploy with `PAXEL_WEBHOOK_ENABLED=false`.
2. Obtain the remaining signature answers (section 3.A/3.B) and one **real signed push**.
3. Add that push as a test vector; adjust verification only if Paxel's spec requires it.
4. On **staging**: set `PAXEL_WEBHOOK_ENABLED=true` and `PAXEL_WEBHOOK_SECRET=<from Paxel>`,
   confirm the staging nginx allowlist (section 4), register the staging URL on the staging
   Corporate Account, and have Paxel send test pushes for a staging booking
   (staging forces the notification allowlist, so no real customer is messaged).
5. Verify: status, `ShipmentHistory`, `metadata.paxel.webhook` (observations, logs,
   actuals, media links), order status, one `shipment.status` notification row.
6. Re-send the same push: expect 200 and no new history/notification.
7. Only then: set both variables in the **production** env file with the production secret
   (never staging's), make sure the production API route is covered by the Paxel allowlist
   (section 4: TEMPORARILY both IPs while staging coexists on this VPS; `34.126.76.148` only
   once staging is retired),
   give the production webhook URL to Paxel's Sales Team for **CMS Production** registration
   on the production Corporate Account, and
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
| `paxel.unmapped_status` | unconfirmed code (FAILED3PL, ONHOLD3PL, any new one) recorded, no transition | needs an operator's attention (item J: AS-IS until Paxel confirms) |
| `paxel.signature_missing` / `paxel.signature_invalid` | 401 | **any** from Paxel → item A/B |
| `paxel.validation_failed` | 400 | **any** → Paxel's real payload differs |
| `paxel.invoice_mismatch` | 409 | **any** → item F |
| `paxel.unknown_shipment` | 404 | AWBs not booked by this shop |
| `paxel.failed` | 500 | database/infra problem |

Edge: nginx `403` responses on `/api/v1/shipments/webhook/paxel` mean a request came from an
address other than the environment's Paxel IP — expected for scans; **from Paxel it means
Paxel's source IP changed** (update section 4 after confirming with Paxel).

The request signature is never logged (it is redacted from request logs) and never stored.
