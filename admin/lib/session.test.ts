import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  clearAdminSessionMarker,
  hasAdminSessionMarker,
  LEGACY_AUTH_TOKEN_KEY,
  purgeLegacyStoredToken,
  readCookie,
} from './session.ts';

/**
 * H2/H4 — the admin UI never holds the admin JWT.
 *
 * Runtime tests exercise the dependency-free session helpers against stubbed browser
 * globals; the wiring tests pin the source (no component-render harness exists in
 * this package - same approach as invoice-link-panel.test.ts).
 */

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG0tMSJ9.c2lnbmF0dXJl';

function installBrowser(hostname = 'staging-admin.baksomassular.com', cookie = '') {
  const store = new Map<string, string>();
  const writes: string[] = [];
  const g = globalThis as Record<string, unknown>;
  g.window = {
    location: { hostname, protocol: 'https:' },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
  g.document = {
    get cookie() { return cookie; },
    set cookie(v: string) { writes.push(v); },
  };
  return { store, writes };
}

test('a JWT left in localStorage by the old client is purged', () => {
  const { store } = installBrowser();
  store.set(LEGACY_AUTH_TOKEN_KEY, JWT);
  store.set('mas-sular-admin-permissions', '["Order.read"]');
  purgeLegacyStoredToken();
  assert.equal(store.has(LEGACY_AUTH_TOKEN_KEY), false);
  for (const value of store.values()) assert.doesNotMatch(value, /eyJ[\w-]+\.[\w-]+\./);
});

test('session presence comes from the token-free marker cookie', () => {
  installBrowser('staging-admin.baksomassular.com', 'XSRF-TOKEN=abc; ms_admin_session=true');
  assert.equal(hasAdminSessionMarker(), true);
  assert.equal(readCookie('XSRF-TOKEN'), 'abc');
  installBrowser('staging-admin.baksomassular.com', 'XSRF-TOKEN=abc');
  assert.equal(hasAdminSessionMarker(), false);
  // The httpOnly access cookie is invisible to page script by construction.
  assert.equal(readCookie('ms_admin_access'), undefined);
});

test('clearing the marker covers the host-only and every parent-domain form', () => {
  const { writes } = installBrowser('staging-admin.baksomassular.com');
  clearAdminSessionMarker();
  assert.ok(writes.some((w) => /^ms_admin_session=; Max-Age=0; Path=\/$/.test(w)));
  assert.ok(writes.some((w) => w.endsWith('Domain=.baksomassular.com')));
  assert.ok(writes.every((w) => !w.includes('Domain=.com')));
});

// ------------------------------------------------------------ source wiring --

const ROOT = join(import.meta.dirname, '..');
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name.startsWith('.')) return [];
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts') ? [full] : [];
  });
}
const SOURCES = ['app', 'components', 'lib', 'store'].flatMap((d) => sources(join(ROOT, d)));
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** Source with comments removed, so documentation that mentions a pattern is not flagged. */
const code = (file: string) =>
  readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

test('no source stores, reads or sends the admin JWT from script', () => {
  for (const file of SOURCES) {
    const src = code(file);
    const rel = file.slice(ROOT.length);
    assert.doesNotMatch(src, /getAuthToken|setAuthToken/, `${rel} still uses the removed token accessors`);
    assert.doesNotMatch(src, /Authorization['"]?\s*[:,]\s*`?Bearer/, `${rel} sends a Bearer header`);
    assert.doesNotMatch(src, /localStorage\.setItem\([^)]*[Tt]oken/, `${rel} writes a token to localStorage`);
    assert.doesNotMatch(src, /accessToken|refreshToken/, `${rel} handles an access/refresh token`);
  }
});

test('no credential is ever placed in a URL (the SSE ?token= leak)', () => {
  for (const file of SOURCES) {
    assert.doesNotMatch(code(file), /[?&](token|access_token|jwt)=/, `${file.slice(ROOT.length)} builds a credential URL`);
  }
  const notifications = read('lib/notifications.ts');
  assert.match(notifications, /\/admin\/notifications\/stream`/);
  assert.match(notifications, /withCredentials: true/);
  assert.match(read('components/notifications/notification-bell.tsx'), /new EventSource\(url, BELL_STREAM_INIT\)/);
});

test('every raw request carries the session cookie; writes carry the CSRF header', () => {
  const api = read('lib/api.ts');
  assert.match(api, /credentials: 'include'/);
  assert.match(api, /csrfHeaders\(method\)/);
  for (const rel of ['lib/upload.ts', 'lib/admin.ts']) {
    const src = read(rel);
    assert.match(src, /credentials: 'include'/, rel);
    assert.match(src, /csrfHeaders\('POST'\)/, rel);
  }
});

test('the login response type no longer carries a token', () => {
  assert.doesNotMatch(read('lib/auth-actions.ts'), /accessToken|refreshToken/);
});

test('permissions match exactly and only the canonical SUPER_ADMIN role is super', () => {
  const src = read('lib/permissions.ts');
  assert.doesNotMatch(src, /expandPermissionAliases|'Super Admin'/);
});
