# Bakso Mas Sular Platform

Production-ready modular-monolith ecommerce architecture for the existing `frontend/` storefront, with a NestJS backend and a separate Next.js admin CMS.

## Frontend Analysis

The existing storefront currently uses local mock data and Zustand persistence for:

- Catalog: products, categories, toppings, promos, product detail, related products, favorites.
- Cart: quantity, toppings, spicy level, notes, promo code, delivery fee threshold.
- Checkout: saved address, QRIS, manual transfer, COD, order creation.
- Account: Google-only login, onboarding address form, profile, addresses, order history.

The backend contracts were generated around those flows.

## Architecture Plan

- Backend: NestJS, Clean Architecture module boundaries, Prisma/PostgreSQL persistence, Redis cache/session/rate-limit/queue backing, RabbitMQ domain events.
- Admin: Next.js App Router, Tailwind, TanStack Query, Zustand, CMS/operations screens.
- Modules: `auth`, `users`, `catalog`, `cart`, `orders`, `payments`, `shipping`, `cms`, `audit`.
- Boundaries: each business module is prepared for CQRS by separating DTOs, domain contracts, infrastructure repositories/providers, and presentation controllers.
- Future migration: RabbitMQ events and repository/provider interfaces keep payment, shipping, inventory, and notification workflows separable later.

## Key API Contracts

- `POST /api/v1/auth/google`
- `POST /api/v1/auth/refresh`
- `GET /api/v1/catalog/products?search=&category=&sort=popular`
- `GET /api/v1/catalog/products/:idOrSlug`
- `GET /api/v1/catalog/categories`
- `GET /api/v1/catalog/toppings`
- `GET /api/v1/catalog/promos`
- `POST /api/v1/cart/sessions`
- `POST /api/v1/orders/checkout`
- `GET /api/v1/orders/users/:userId`
- `POST /api/v1/payments/:paymentId/manual-receipt`
- `PATCH /api/v1/payments/:paymentId/verify`
- `POST /api/v1/shipping/rates`
- `GET /api/v1/shipping/:provider/track/:trackingNumber`
- `GET /api/v1/cms/banners?placement=home`
- `GET /api/v1/audit-logs`

## Local Setup

Local development runs PostgreSQL 16, Redis and RabbitMQ in Docker
(`docker-compose.yml`, project `mas-sular-dev`). Nothing local depends on the
retired shared infrastructure (the old MySQL, Upstash Redis or CloudAMQP).

1. Install dependencies:

   ```bash
   pnpm install
   ```

### Option A: everything in Docker

No env file is required. The backend container loads the committed
`backend/.env.example` (placeholders only), and Compose injects the service-DNS
`DATABASE_URL` / `REDIS_URL` / `RABBITMQ_URL`.

```bash
docker compose up -d        # postgres, redis, rabbitmq, migrations, backend, storefront, admin
docker compose run --rm --no-deps backend-migrate node node_modules/tsx/dist/cli.mjs prisma/seed.ts   # optional dev seed
```

Optional overrides, all gitignored:

- `.env` (from `.env.example`): local Postgres/RabbitMQ credentials, host ports and
  storefront/admin build args. Every value has the same default in `docker-compose.yml`.
- `backend/.env.docker`: your own backend values on top of `backend/.env.example`
  (e.g. Midtrans/courier **sandbox** keys). List only the keys you change. Never
  commit it.

### Option B: apps on the host, infrastructure in Docker

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
cp admin/.env.example admin/.env

docker compose up -d postgres redis rabbitmq
pnpm --filter ./backend prisma:generate
pnpm --filter ./backend prisma:deploy   # apply committed migrations (prisma:migrate is for authoring new ones)
pnpm --filter ./backend prisma:seed     # optional dev seed
pnpm dev                                # backend + admin + storefront in parallel
```

Stop the Docker `backend`, `frontend` and `admin` containers first if they are
running; they publish the same ports (3001/3000/3002). If you already have a
`backend/.env` from before the PostgreSQL migration, recreate it from the
template. An old file may still point at the retired shared MySQL/Redis/RabbitMQ.

### Env files at a glance

| File | Used by | Notes |
|---|---|---|
| `backend/.env.example` | backend (`backend/.env` on the host; loaded directly by local Docker) | Local values. `CHANGE_ME` placeholders boot locally and are refused in staging/production |
| `frontend/.env.example` | storefront `next dev` (copy to `frontend/.env`) | `NEXT_PUBLIC_*` only (public, never secrets) |
| `admin/.env.example` | admin `next dev` (copy to `admin/.env`) | `NEXT_PUBLIC_API_URL` only |
| `.env.example` | `docker compose` interpolation only | Credentials, host ports, build args |
| `production.env.example` | **production only** (copy to `production.env`) | See [Production configuration](#production-configuration) |

**The two apps use different API URL contracts:**

- Storefront `NEXT_PUBLIC_API_URL` is the **bare origin**: `http://localhost:3001`.
  The storefront appends `/api/v1` itself; its image build refuses a value ending in `/api/v1`.
- Admin `NEXT_PUBLIC_API_URL` **includes the prefix**: `http://localhost:3001/api/v1`.
  The admin appends paths directly; its image build refuses anything else. In
  Compose files the admin's value is named `NEXT_PUBLIC_ADMIN_API_URL`.

Customer Google Sign-In needs a real OAuth client id in both the backend's
`GOOGLE_CLIENT_ID` and the storefront's `NEXT_PUBLIC_GOOGLE_CLIENT_ID` (the same
value). Everything else works with the template values.

## Production configuration

Production does **not** read `backend/.env.example`, `frontend/.env.example`,
`admin/.env.example` or the root `.env`. It uses one file, `production.env`, created
from `production.env.example` and never committed:

```bash
cp production.env.example production.env && chmod 600 production.env
# fill in every CHANGE_ME / <PLACEHOLDER>
docker compose --env-file ./production.env -f docker-compose.production.yml up -d --build
```

- The backend receives it as `env_file`. `NODE_ENV=production` refuses to boot
  while any `CHANGE_ME` / `<PLACEHOLDER>` value remains.
- The storefront and admin receive their `NEXT_PUBLIC_*` values as **build args**
  from the same file. `NEXT_PUBLIC_API_URL` (storefront, bare origin) and
  `NEXT_PUBLIC_ADMIN_API_URL` (admin, `/api/v1`) are both required. Changing one
  means rebuilding (`up -d --build <service>`), not restarting.

## Root Command Reference

- `pnpm infra:up` – start PostgreSQL, Redis, and RabbitMQ services
- `pnpm infra:down` – stop Docker Compose services
- `pnpm dev` – start infrastructure and run backend + admin + frontend in parallel
- `pnpm dev:all` – start infrastructure and run backend + admin + frontend in parallel
- `pnpm dev:backend` – run only the backend
- `pnpm dev:admin` – run only the admin app
- `pnpm dev:frontend` – run only the storefront
- `pnpm build:all` – build all three apps
- `pnpm lint:all` – lint all three apps

## Deploying Standalone Projects

Each app can be built and started independently. The supported production deployment is
`docker-compose.production.yml` with `production.env` (see [Production configuration](#production-configuration)).

### Backend

```bash
cd backend
pnpm install
pnpm build
pnpm start
```

### Admin

```bash
cd admin
pnpm install
pnpm build
pnpm start
```

### Frontend

```bash
cd frontend
pnpm install
pnpm build
pnpm start
```

## URLs

- Storefront: `http://localhost:3000`
- Backend API: `http://localhost:3001/api/v1`
- Swagger: `http://localhost:3001/docs`
- Admin CMS: `http://localhost:3002`
- RabbitMQ UI: `http://localhost:15672`

## Production Notes

- Configure production only through `production.env`. The API refuses to boot while a `CHANGE_ME` / `<PLACEHOLDER>` value remains.
- Configure real Google OAuth verification for `POST /auth/google`.
- Add object storage for receipt/product/banner uploads.
- Add worker processes for queues if async volume grows.
- Use migration deploy in CI/CD: `pnpm --filter backend prisma:deploy`.
- Add provider credentials for Paxel/JNE when moving from mocked providers to real integrations.
