# Bakso Mas Sular — UAT Automation Harness (Playwright)

Automates the UAT checklist in `../UAT_Checklist_Bakso_Mas_Sular.xlsx` (7 module
worksheets, 92 cases). Locators are semantic (role / label / text) since the app
has **no `data-testid`**.

## Status of this harness
- ✅ Harness, fixtures, reporters, Excel writer, report generators — authored & compiling.
- ⏸️ **0 cases executed live** in the build environment: it has **no Docker / MySQL /
  Redis**, so the NestJS backend (fail-fast on `DATABASE_URL`/`REDIS_URL`) cannot boot
  and nothing is reachable. All cases are marked **Blocked** (never fabricated Pass/Fail).
- Customer auth uses **backend cookie-mint** (Google OAuth can't be automated); admin
  uses **real email/password** login.

## Prerequisites to actually run
1. **Infra:** `docker compose up -d` (MySQL/Redis/RabbitMQ) at repo root.
2. **Backend env:** copy `backend/.env.example` → `backend/.env`, set secrets +
   `GOOGLE_CLIENT_ID`; `cd backend && npx prisma migrate deploy && pnpm seed`.
3. **Seed UAT users/data:** create a test customer + admin, export their ids/creds (see env below).
4. **Apps up:** `backend` (`:3001`), `frontend` (`:3000`), `admin` (`:3002`).

## Required env for the run
```
CUSTOMER_URL=http://localhost:3000
ADMIN_URL=http://localhost:3002
API_URL=http://localhost:3001/api/v1
# Admin login (automatable):
ADMIN_EMAIL=...           ADMIN_PASSWORD=...
# Customer cookie-mint (OAuth not automatable):
JWT_ACCESS_SECRET=...      # MUST match backend
CUSTOMER_TEST_ID=...       # seeded customer user id
CUSTOMER_TEST_EMAIL=uat.customer@masular.test
# Optional: COOKIE_DOMAIN=.baksomassular.com  (prod-like)
```

## Run
```bash
cd e2e
pnpm install
npx playwright install chromium
npx playwright test              # executes; trace/video/screenshot on failure
python scripts/update_excel.py   # writes Status/Tester/Notes into the workbook
python scripts/gen_reports.py    # Markdown summary + Bug report
npx playwright show-report reports/html
```

## Outputs
- `reports/html/` — Playwright HTML report (traces, videos, screenshots)
- `reports/results.json` — machine-readable results (consumed by the scripts)
- `reports/UAT_Summary.md` — totals + pass rate + failures by module
- `reports/Bug_Report.md` — one entry per FAIL (severity/steps/expected/actual/evidence/cause)
- `artifacts/{screenshots,traces,videos,logs}/` — raw evidence

## Coverage model
- **Runnable without auth (will execute once stack is up):** CF-001..007/010, AUTH login/
  negative-API cases, ADM-018, PAY-003, SEC-001/003/010/011, etc.
- **Authored but `fixme` (need seed data / mutating / OAuth-blocked):** the remaining
  authenticated & data-dependent cases — annotated with their TC ID, ready to flesh out
  against a disposable seed DB.
- Every TC ID is represented; nothing is skipped silently.
