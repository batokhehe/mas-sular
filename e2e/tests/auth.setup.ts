import { test as setup, expect, request } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import jwt from 'jsonwebtoken';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  API_URL,
  CUSTOMER_TEST_EMAIL,
  CUSTOMER_URL,
  ADMIN_URL,
  JWT_ACCESS_SECRET,
  JWT_ACCESS_TTL,
  STORAGE,
} from '../utils/env';

function save(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function hostOf(url: string) {
  return new URL(url).hostname;
}

/**
 * CUSTOMER — Google OAuth cannot be driven by Playwright, so we MINT a session
 * the way the chosen strategy dictates: sign an access JWT with the backend's
 * JWT_ACCESS_SECRET for a seeded test customer, and write it as the httpOnly-style
 * ms_access cookie + the JS-readable ms_session marker into Playwright storageState.
 *
 * Prereq: backend seed has created a customer with CUSTOMER_TEST_EMAIL and the
 * corresponding user id is exported as CUSTOMER_TEST_ID (set by scripts/seed-uat).
 */
setup('mint customer session', async () => {
  setup.skip(!JWT_ACCESS_SECRET, 'JWT_ACCESS_SECRET not provided — cannot mint customer cookie');
  const sub = process.env.CUSTOMER_TEST_ID;
  setup.skip(!sub, 'CUSTOMER_TEST_ID not provided — run scripts/seed-uat first');

  const token = jwt.sign(
    { sub, email: CUSTOMER_TEST_EMAIL, roles: ['CUSTOMER'] },
    JWT_ACCESS_SECRET,
    { expiresIn: JWT_ACCESS_TTL as jwt.SignOptions['expiresIn'] },
  );
  const host = hostOf(CUSTOMER_URL);
  save(STORAGE.customer, {
    cookies: [
      { name: 'ms_access', value: token, domain: host, path: '/', httpOnly: true, secure: false, sameSite: 'Lax', expires: -1 },
      { name: 'ms_session', value: 'true', domain: host, path: '/', httpOnly: false, secure: false, sameSite: 'Lax', expires: -1 },
    ],
    origins: [],
  });
});

/**
 * ADMIN — email/password login is fully automatable (no OAuth). We call the real
 * endpoint and persist the token the standalone admin app expects in localStorage
 * (mas-sular-admin-token) for the ADMIN_URL origin.
 */
setup('login admin', async () => {
  setup.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'ADMIN_EMAIL/ADMIN_PASSWORD not provided');
  const ctx = await request.newContext();
  const res = await ctx.post(`${API_URL}/admin/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(res.ok(), `admin login failed: ${res.status()}`).toBeTruthy();
  const body = await res.json();
  const token: string = body.accessToken;
  const perms = JSON.stringify(body.permissions ?? []);
  const origin = ADMIN_URL;
  save(STORAGE.admin, {
    cookies: [],
    origins: [
      {
        origin,
        localStorage: [
          { name: 'mas-sular-admin-token', value: token },
          { name: 'mas-sular-admin-permissions', value: perms },
        ],
      },
    ],
  });
  await ctx.dispose();
});
