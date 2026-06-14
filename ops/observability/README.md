# Observability — Mas Sular outbox/notification pipeline (Phase 7B2)

IaC for alerting and dashboards on top of the Prometheus metrics emitted by
Phase 7B1 (`masular_*` at the backend `GET /metrics`) plus RabbitMQ queue
metrics. **Config only — no application or schema changes.**

```
ops/observability/
├── prometheus/
│   ├── prometheus.yml          # scrape backend + rabbitmq, load rules, point at alertmanager
│   └── alerts.yml              # the 6 alert rules (warning/critical tiers)
├── alertmanager/
│   └── alertmanager.yml        # critical→pager, warning→slack, inhibition
├── grafana/
│   ├── provisioning/           # datasource + dashboard providers
│   └── dashboards/             # throughput / saturation / errors / lifecycle / latency
├── rabbitmq/
│   ├── enabled_plugins         # rabbitmq_management + rabbitmq_prometheus
│   └── rabbitmq.conf           # per-object (per-queue) metrics → DLQ depth
└── docker-compose.observability.yml
```

## Run (local)

From the **repo root** (bind-mount paths are repo-root relative):

```bash
docker compose -f docker-compose.yml -f ops/observability/docker-compose.observability.yml up -d
```

| Service | URL |
|---|---|
| Prometheus | http://localhost:9090 (Status → Rules / Alerts) |
| Alertmanager | http://localhost:9093 |
| Grafana | http://localhost:3002 (admin/admin; dashboards under the **Mas Sular** folder) |
| RabbitMQ metrics | http://localhost:15692/metrics/per-object |

The backend runs on the host (`pnpm`); Prometheus scrapes it via
`host.docker.internal:3001`. Override `prometheus.yml` `static_configs` for a
containerised/prod backend.

## Before production
- Replace the placeholder webhook URLs in `alertmanager.yml` with a real
  PagerDuty/Opsgenie key (`pager`) and Slack webhook (`slack-default`).
- Front `GET /metrics` with network ACLs/auth (7B1 left it unauthenticated).
- Tune thresholds against real load — see each alert below. Roll alerts out in
  **observe** mode first, then enable paging.

---

## Alert catalog & thresholds

| Alert | Warning | Critical | Routing |
|---|---|---|---|
| **RelayFailedGrowth** | `increase(masular_relay_failed_total[15m]) > 0` for 15m | `> 10` for 5m | warn→Slack, crit→pager |
| **NotificationFailedGrowth** | `(permanent+exhausted increase[15m]) > 0` for 15m | `> 10` for 5m | warn→Slack, crit→pager |
| **DLQDepth** | `rabbitmq_queue_messages{…dlq} > 0` for 5m | `> 10` for 5m | warn→Slack, crit→pager |
| **SenderBreakerOpen** | — | `masular_notification_sender_breaker_open == 1` for 5m | pager |
| **OldestPendingAgeHigh** (relay & notification) | `oldest_age > 300s` for 10m | `> 900s` for 5m | warn→Slack, crit→pager |
| **RetentionNotRunning** | `time() - last_run > 26h` for 1h | — | Slack (P1) |

Noise control: only `severity=critical` routes to the pager; an inhibition rule
drops the warning whenever the matching critical (same `alertname`+`pipeline`)
is firing. `RetentionNotRunning` deliberately fires only when the gauge exists
but is stale, so it stays silent when retention is intentionally disabled.

---

## Operational runbook

### RelayFailedGrowth
Outbox events are exhausting publish retries and landing in `FAILED`.
1. **Errors** dashboard → relay failures; **Saturation** → relay backlog/oldest age.
2. Check the broker: `rabbitmq` reachable, exchange/queues present, disk alarm off.
3. Inspect `lastError` on `OutboxEvent WHERE status='FAILED'` for the common cause.
4. Fix the root cause (broker/network/credentials).
5. Redrive: `RedriveService.redriveFailedOutboxEvents({ dryRun: true })` to count,
   then without `dryRun` to reset `FAILED → PENDING`. The relay re-publishes;
   downstream dedup makes re-delivery safe.
6. Confirm `masular_relay_failed_backlog` drains and `published_total` rises.

### NotificationFailedGrowth
Notifications are terminally failing (permanent rejects or exhausted retries).
1. **Errors** dashboard → sender terminal failures (permanent vs exhausted).
2. `permanent` spike → bad recipients/templates (provider 4xx). Inspect
   `NotificationOutbox.lastError`. Fix data; these are not auto-retried.
3. `exhausted` spike → sustained transient/provider outage; often pairs with
   **SenderBreakerOpen**. Resolve the provider issue first.
4. After the fix, `RedriveService.redriveFailedNotifications({ … })`
   (dry-run first) to requeue recoverable rows.

### DLQDepth
Messages are accumulating in `order.created.notifications.dlq` (poison or
repeatedly failing deliveries).
1. **Saturation** dashboard → DLQ depth trend.
2. Inspect: `RedriveService.redriveConsumerDlq({ limit, dryRun: true })` logs each
   `messageId` without removing it.
3. Identify the poison cause (unparseable body, missing `messageId`, persistent
   downstream error). Fix the root cause.
4. Drain: `redriveConsumerDlq({ limit, dryRun: false })` shovels messages back to
   the source exchange (confirmed publish before ack — no loss). Bounded by `limit`.
5. Confirm depth returns to 0.

### SenderBreakerOpen
The sender circuit breaker has been open >5m (paused on sustained transient/infra
failure) — nothing is being sent.
1. **Errors** dashboard → breaker state timeline; correlate with sender failures.
2. Likely causes: provider 5xx, provider `401` (rotated/invalid `RESEND_API_KEY`),
   or DB connectivity (claim/update failing).
3. Verify provider status and credentials; verify the DB is reachable.
4. The breaker auto-resumes on the first successful send after `pauseMs`; no manual
   action once the dependency recovers. Watch `breaker_open` return to 0 and
   `sent_total` resume.

### OldestPendingAgeHigh
The oldest unprocessed row (relay `OutboxEvent` or notification) is aging — the
backlog is not draining.
1. **Saturation** dashboard → which pipeline (label `pipeline=relay|notification`).
2. Check the worker is alive and its flag is enabled
   (`OUTBOX_RELAY_ENABLED` / `NOTIFICATION_SENDER_ENABLED`).
3. Check for an open breaker (sender) or broker outage (relay).
4. If a worker is down, restart it; the backlog drains on resume. If the cause is
   downstream, resolve it — age falls as rows are processed.

### RetentionNotRunning
The retention sweep hasn't run in >26h (daily expectation), so terminal/expired
rows accumulate.
1. **Lifecycle** dashboard → "Time since last retention sweep".
2. Confirm `RETENTION_ENABLED=true` and the worker/process is running.
3. Check logs for `retention run failed`. Resolve (usually DB) and confirm the
   `masular_retention_last_run_timestamp_seconds` gauge advances on the next cycle.

---

## Not in scope (deferred)
- `RedriveActivitySpike` (P1, informational) — add once redrive cadence is known.
- Recording rules / SLO burn-rate alerts.
- Real pager/Slack integration secrets (placeholders here).
