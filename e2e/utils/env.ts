/** Central env/URL resolution for the UAT harness. */
export const CUSTOMER_URL = process.env.CUSTOMER_URL ?? 'http://localhost:3000';
export const ADMIN_URL = process.env.ADMIN_URL ?? 'http://localhost:3002';
export const API_URL = process.env.API_URL ?? 'http://localhost:3001/api/v1';

/** Credentials/secrets injected at run time (NEVER hardcode). */
export const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? '';
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';
export const CUSTOMER_TEST_EMAIL = process.env.CUSTOMER_TEST_EMAIL ?? 'uat.customer@masular.test';

/** Backend JWT secret used to mint a customer session (OAuth can't be automated). */
export const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? '';
export const JWT_ACCESS_TTL = process.env.JWT_ACCESS_TTL ?? '1d';

/** Parent cookie domain (must match backend COOKIE_DOMAIN); empty → host-only (dev). */
export const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN ?? '';

export const STORAGE = {
  customer: 'artifacts/.auth/customer.json',
  admin: 'artifacts/.auth/admin.json',
};
