# Baso Nusantara Platform

Production-ready modular-monolith ecommerce architecture for the existing `frontend/` storefront, with a NestJS backend and a separate Next.js admin CMS.

## Frontend Analysis

The existing storefront currently uses local mock data and Zustand persistence for:

- Catalog: products, categories, toppings, promos, product detail, related products, favorites.
- Cart: quantity, toppings, spicy level, notes, promo code, delivery fee threshold.
- Checkout: saved address, QRIS, manual transfer, COD, order creation.
- Account: Google-only login, onboarding address form, profile, addresses, order history.

The backend contracts were generated around those flows.

## Architecture Plan

- Backend: NestJS, Clean Architecture module boundaries, Prisma/MySQL persistence, Redis cache/session/rate-limit/queue backing, RabbitMQ domain events.
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

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Copy env files:

   ```bash
   cp .env.example .env
   cp backend/.env.example backend/.env
   cp admin/.env.example admin/.env
   ```

3. Start infrastructure:

   ```bash
   docker compose up -d mysql redis rabbitmq
   ```

4. Prepare database:

   ```bash
   pnpm --filter backend prisma:generate
   pnpm --filter backend prisma:migrate
   pnpm --filter backend prisma:seed
   ```

5. Run apps:

   ```bash
   pnpm --filter backend dev
   pnpm --filter admin dev
   pnpm --filter frontend dev
   ```

## URLs

- Storefront: `http://localhost:3000`
- Backend API: `http://localhost:3001/api/v1`
- Swagger: `http://localhost:3001/docs`
- Admin CMS: `http://localhost:3002`
- RabbitMQ UI: `http://localhost:15672`

## Production Notes

- Replace all secrets in env files before deployment.
- Configure real Google OAuth verification for `POST /auth/google`.
- Add object storage for receipt/product/banner uploads.
- Add worker processes for queues if async volume grows.
- Use migration deploy in CI/CD: `pnpm --filter backend prisma:deploy`.
- Add provider credentials for Paxel/JNE when moving from mocked providers to real integrations.
