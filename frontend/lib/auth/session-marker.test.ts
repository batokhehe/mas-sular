import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * P0-2 — a stale `ms_session` marker must not turn every page load into a 401.
 *
 * The marker (JS-readable, value "true", Domain=COOKIE_DOMAIN) is what enables
 * /users/me and /users/addresses. Before: when the API refused the refresh the
 * client removed only the legacy token cookies, so the marker survived and every
 * navigation repeated 401 -> refresh 401 -> "Unauthorized" toast.
 *
 * These tests drive the REAL api client and token helpers (and the real js-cookie)
 * against a minimal browser cookie jar and a stubbed fetch - no network.
 */

// lib/api/client.ts imports '@/lib/auth/tokens' (the Next.js alias); map '@/x' to
// '<frontend>/x.ts' for node's runner - test-local only.
const ROOT = join(import.meta.dirname, '..', '..')
register(
  'data:text/javascript,' +
    encodeURIComponent(`
const ROOT = ${JSON.stringify(pathToFileURL(ROOT + '/').href)};
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) return next(new URL(specifier.slice(2) + '.ts', ROOT).href, context);
  return next(specifier, context);
}`),
  import.meta.url,
)

// ---- a minimal cookie jar with browser semantics for name/domain/path/expiry ----
type Cookie = { name: string; value: string; domain: string; path: string }
const jar = new Map<string, Cookie>()
const cookieWrites: string[] = []
const norm = (d: string) => d.replace(/^\./, '').toLowerCase()
function writeCookie(header: string) {
  cookieWrites.push(header)
  const [pair, ...attrs] = header.split(';').map((s) => s.trim())
  const eq = pair.indexOf('=')
  const name = pair.slice(0, eq)
  const value = pair.slice(eq + 1)
  let domain = ''
  let path = '/'
  let expired = false
  for (const a of attrs) {
    const [k, v = ''] = a.split('=')
    if (k.toLowerCase() === 'domain') domain = norm(v)
    if (k.toLowerCase() === 'path') path = v
    if (k.toLowerCase() === 'expires' && new Date(v).getTime() < Date.now()) expired = true
  }
  const key = `${name}|${domain}|${path}`
  if (expired) jar.delete(key)
  else jar.set(key, { name, value, domain, path })
}
/** What the backend's Set-Cookie leaves in the browser (not script-written). */
const serverSets = (name: string, value: string, domain = '') => jar.set(`${name}|${norm(domain)}|/`, { name, value, domain: norm(domain), path: '/' })

const localStorageWrites: string[] = []
Object.assign(globalThis, {
  window: {
    location: { hostname: 'staging.baksomassular.com', protocol: 'https:' },
    localStorage: { getItem: () => null, setItem: (k: string) => void localStorageWrites.push(k), removeItem: () => {} },
  },
  document: {
    get cookie() {
      return [...jar.values()].map((c) => `${c.name}=${c.value}`).join('; ')
    },
    set cookie(header: string) {
      writeCookie(header)
    },
  },
})

// ---- fetch stub: /users/me, /users/addresses and /auth/refresh ----
type Reply = { status: number; body?: unknown }
let routes: Record<string, () => Reply> = {}
const calls: string[] = []
globalThis.fetch = (async (input: string) => {
  const path = String(input).replace(/^.*\/api\/v1/, '')
  calls.push(path)
  await new Promise((r) => setTimeout(r, 5)) // let parallel requests overlap
  const reply = routes[path]?.() ?? { status: 404, body: { message: 'Not found' } }
  return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), { status: reply.status })
}) as typeof fetch

const { api, ApiError } = await import('../api/client.ts')
const { hasCustomerSession, clearCustomerSessionMarker, cookieDomainCandidates } = await import('./tokens.ts')

const UNAUTHORIZED: Reply = { status: 401, body: { message: 'Unauthorized', statusCode: 401 } }
const ME: Reply = { status: 200, body: { id: 'u1', name: 'Budi' } }
const refreshCalls = () => calls.filter((c) => c === '/auth/refresh').length

beforeEach(() => {
  jar.clear()
  calls.length = 0
  cookieWrites.length = 0
  localStorageWrites.length = 0
  routes = {}
  // The marker as the API issues it: Domain=.baksomassular.com, shared with staging.*.
  serverSets('ms_session', 'true', '.baksomassular.com')
})

test('stale marker: refresh refused -> the marker is cleared, the page is cleanly signed out', async () => {
  routes['/users/me'] = () => UNAUTHORIZED
  routes['/auth/refresh'] = () => UNAUTHORIZED
  assert.equal(hasCustomerSession(), true, 'precondition: a stale marker')

  await assert.rejects(api.get('/users/me', 'customer'), (e: unknown) => e instanceof ApiError && e.status === 401)
  assert.equal(refreshCalls(), 1)
  assert.equal(hasCustomerSession(), false, 'the parent-domain marker is gone')
  assert.equal([...jar.keys()].some((k) => k.startsWith('ms_session|')), false)

  // Next page load: every session-gated query is disabled (enabled: hasCustomerSession()),
  // so there is no second 401, no second refresh, no toast loop.
  assert.equal(hasCustomerSession(), false)
  assert.deepEqual(calls, ['/users/me', '/auth/refresh'])
})

test('valid session: an expired access token is refreshed once, the request succeeds, the marker stays', async () => {
  let authed = false
  routes['/users/me'] = () => (authed ? ME : UNAUTHORIZED)
  routes['/auth/refresh'] = () => ((authed = true), { status: 200, body: {} })

  assert.deepEqual(await api.get('/users/me', 'customer'), ME.body)
  assert.deepEqual(calls, ['/users/me', '/auth/refresh', '/users/me'])
  assert.equal(hasCustomerSession(), true)
})

test('parallel 401s share ONE refresh (refresh tokens are single-use) and keep the session', async () => {
  let authed = false
  let rotations = 0
  routes['/users/me'] = () => (authed ? ME : UNAUTHORIZED)
  routes['/users/addresses'] = () => (authed ? { status: 200, body: [] } : UNAUTHORIZED)
  // A second refresh with the already-rotated token would be refused by the API.
  routes['/auth/refresh'] = () => (++rotations === 1 ? ((authed = true), { status: 200, body: {} }) : UNAUTHORIZED)

  const [me, addresses] = await Promise.all([api.get('/users/me', 'customer'), api.get('/users/addresses', 'customer')])
  assert.deepEqual(me, ME.body)
  assert.deepEqual(addresses, [])
  assert.equal(refreshCalls(), 1)
  assert.equal(hasCustomerSession(), true, 'a live session is never signed out by a refresh race in one tab')
})

test('a refresh that fails for network/server reasons says nothing about the session: marker kept', async () => {
  routes['/users/me'] = () => UNAUTHORIZED
  routes['/auth/refresh'] = () => ({ status: 503, body: { message: 'Service Unavailable' } })
  await assert.rejects(api.get('/users/me', 'customer'))
  assert.equal(hasCustomerSession(), true)

  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: string) => {
    if (String(input).endsWith('/auth/refresh')) throw new TypeError('Failed to fetch')
    return realFetch(input)
  }) as typeof fetch
  try {
    await assert.rejects(api.get('/users/me', 'customer'))
  } finally {
    globalThis.fetch = realFetch
  }
  assert.equal(hasCustomerSession(), true)
})

test('public requests never refresh or touch the marker', async () => {
  routes['/catalog/products'] = () => UNAUTHORIZED
  await assert.rejects(api.get('/catalog/products'))
  assert.equal(refreshCalls(), 0)
  assert.equal(hasCustomerSession(), true)
})

test('after a fresh login the marker works again (the backend re-issues it)', async () => {
  routes['/users/me'] = () => UNAUTHORIZED
  routes['/auth/refresh'] = () => UNAUTHORIZED
  await assert.rejects(api.get('/users/me', 'customer'))
  assert.equal(hasCustomerSession(), false)

  // POST /auth/google responds with Set-Cookie ms_session=true (+ httpOnly tokens).
  serverSets('ms_session', 'true', '.baksomassular.com')
  routes['/users/me'] = () => ME
  assert.equal(hasCustomerSession(), true)
  assert.deepEqual(await api.get('/users/me', 'customer'), ME.body)
})

test('clearCustomerSessionMarker removes the host-only AND the parent-domain copies, nothing else', () => {
  serverSets('ms_session', 'true') // host-only copy
  serverSets('ms_access', 'httponly-in-real-life', '.baksomassular.com')
  serverSets('XSRF-TOKEN', 'csrf', '')
  clearCustomerSessionMarker()
  assert.deepEqual([...jar.values()].map((c) => c.name).sort(), ['XSRF-TOKEN', 'ms_access'])
})

test('cookie domain candidates: the host and each parent down to two labels', () => {
  assert.deepEqual(cookieDomainCandidates('staging.baksomassular.com'), ['staging.baksomassular.com', 'baksomassular.com'])
  assert.deepEqual(cookieDomainCandidates('baksomassular.com'), ['baksomassular.com'])
  assert.deepEqual(cookieDomainCandidates('localhost'), [])
  assert.deepEqual(cookieDomainCandidates('127.0.0.1'), [])
  assert.deepEqual(cookieDomainCandidates(''), [])
})

test('no token ever lands in script storage: no localStorage writes, script only ever deletes cookies', async () => {
  routes['/users/me'] = () => UNAUTHORIZED
  routes['/auth/refresh'] = () => UNAUTHORIZED
  await assert.rejects(api.get('/users/me', 'customer'))
  assert.deepEqual(localStorageWrites, [])
  assert.ok(cookieWrites.length > 0)
  assert.ok(cookieWrites.every((h) => h.split(';')[0].endsWith('=')), 'every script cookie write is a deletion (empty value)')
})

// ----------------------------------------------------------------- wiring --

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\s+/g, ' ')

test('logout clears the marker locally too (the backend call may fail); login is unchanged', () => {
  const ctx = read('lib/auth/auth-context.tsx')
  const logout = ctx.slice(ctx.indexOf('const logout = useCallback'), ctx.indexOf('const adminLogin'))
  assert.match(logout, /await authApi\.logout\(\)\.catch\(\(\) => undefined\) removeLegacyCustomerCookies\(\)/)
  assert.match(logout, /clearCustomerSessionMarker\(\)/)
  assert.match(logout, /qc\.setQueryData\(qk\.me, null\)/)
  assert.match(ctx, /enabled: hasCustomerSession\(\)/)
})

test('query 401s are a signed-out state, not a toast; other query errors and mutation errors still toast', () => {
  const qp = read('providers/query-provider.tsx')
  assert.match(qp, /export const isUnauthenticated = \(error: unknown\): boolean => error instanceof ApiError && error\.status === 401/)
  assert.match(qp, /queryCache: new QueryCache\(\{ .*?onError: \(error\) => \{ if \(isUnauthenticated\(error\)\) return toast\.error\(messageFor\(error\)\) \}, \}\)/)
  const mutation = qp.slice(qp.indexOf('mutationCache'))
  assert.doesNotMatch(mutation, /isUnauthenticated/)
  assert.match(mutation, /toast\.error\(messageFor\(error\)\)/)
})

test('the httpOnly architecture is unchanged: no Bearer header, credentialed fetch, no token storage', () => {
  const client = read('lib/api/client.ts')
  assert.doesNotMatch(client, /Bearer|localStorage|Cookies\.set/)
  assert.match(client, /credentials: 'include'/)
  const tokens = read('lib/auth/tokens.ts')
  assert.doesNotMatch(tokens, /localStorage/)
})
