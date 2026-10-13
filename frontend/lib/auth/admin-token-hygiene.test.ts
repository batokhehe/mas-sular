import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * H4 — the storefront's admin panel never touches the admin JWT. The API sets it as
 * an httpOnly cookie on the API host; this app only sends credentialed requests.
 * Older builds wrote it into a JS-readable cookie and built a Bearer header from it.
 */
const ROOT = join(import.meta.dirname, '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

test('no script-built admin Authorization header', () => {
  const client = read('lib/api/client.ts')
  assert.doesNotMatch(client, /Bearer/)
  assert.match(client, /credentials: 'include'/)
})

test('the admin token is never written to a JS cookie, only the legacy copy is removed', () => {
  const tokens = read('lib/auth/tokens.ts')
  assert.doesNotMatch(tokens, /setAdminToken|Cookies\.set\(KEYS\.adminAccess/)
  assert.match(tokens, /export function removeLegacyAdminCookie/)
  const ctx = read('lib/auth/auth-context.tsx')
  assert.doesNotMatch(ctx, /accessToken|setAdminToken/)
})

test('the admin login response type carries no token', () => {
  const api = read('lib/api/auth.api.ts')
  const block = api.slice(api.indexOf('export interface AdminLoginResponse'), api.indexOf('export const authApi'))
  assert.doesNotMatch(block, /accessToken|refreshToken/)
})
