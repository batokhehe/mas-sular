import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { qk } from '../query/keys.ts'

/**
 * P1 #9 — logout must update auth state without a browser refresh.
 *
 * `AuthProvider` exposes `user` from a mounted `useQuery({ queryKey: qk.me })`.
 * A mounted `useQuery` is a `QueryObserver` bound to ONE cache entry, so whether
 * the header re-renders on logout is decided purely by whether that observer is
 * notified. These tests drive a real QueryObserver — the same primitive React
 * subscribes to — so they pin the behaviour rather than the implementation.
 */

const USER = { id: 'u1', name: 'Budi', email: 'budi@example.com' }

/** The logged-in steady state: `me` populated and an observer mounted on it. */
function mountedSession() {
  const qc = new QueryClient()
  qc.setQueryData(qk.me, USER)
  const observer = new QueryObserver(qc, {
    queryKey: qk.me,
    enabled: true,
    retry: false,
    staleTime: 5 * 60_000,
  })
  const notifications: unknown[] = []
  const unsubscribe = observer.subscribe((r) => notifications.push(r.data))
  return { qc, observer, notifications, unsubscribe }
}

test('logout notifies the mounted observer, so the UI updates without a reload', () => {
  const { qc, observer, notifications, unsubscribe } = mountedSession()
  assert.deepEqual(observer.getCurrentResult().data, USER, 'precondition: logged in')

  // Exactly what auth-context's `logout` does to the cache.
  qc.setQueryData(qk.me, null)

  assert.equal(observer.getCurrentResult().data, null, 'observer must see the logged-out state')
  assert.deepEqual(notifications, [null], 'observer must be notified exactly once → React re-renders')
  unsubscribe()
})

test('REGRESSION: removeQueries() before setQueryData() silently detaches the observer', () => {
  // This was the #9 bug. `removeQueries` destroys the entry the mounted observer
  // is bound to without notifying it, and `setQueryData` then builds a NEW,
  // unobserved entry — so nothing re-renders and the header keeps showing the
  // logged-in user until a full page load rebuilds the observer.
  const { qc, observer, notifications, unsubscribe } = mountedSession()

  qc.removeQueries({ queryKey: qk.me })
  qc.setQueryData(qk.me, null)

  assert.deepEqual(
    observer.getCurrentResult().data,
    USER,
    'documents the broken behaviour: observer still serves the stale user',
  )
  assert.deepEqual(notifications, [], 'and is never notified — hence the required refresh')
  unsubscribe()
})

test('a logged-out cache yields the signed-out header state, not a loading spinner', () => {
  // AuthMenu renders a skeleton while `isLoading`, the Login button when `!user`.
  // `null` is a resolved value, so the menu must fall through to "Login".
  const { qc, observer, unsubscribe } = mountedSession()

  qc.setQueryData(qk.me, null)
  const result = observer.getCurrentResult()

  assert.equal(result.data ?? null, null, 'user is null → Login button')
  assert.equal(result.isLoading, false, 'must not flip back to the loading skeleton')
  unsubscribe()
})

test('login still seeds the cache and notifies the observer (unchanged by the fix)', () => {
  // Guards the symmetric `loginWithGoogle` path so the fix cannot regress it.
  const qc = new QueryClient()
  qc.setQueryData(qk.me, null)
  // staleTime mirrors AuthProvider's meQuery so the observer does not kick off a
  // background fetch (there is no queryFn here) and pollute the notification log.
  const observer = new QueryObserver(qc, {
    queryKey: qk.me,
    enabled: true,
    retry: false,
    staleTime: 5 * 60_000,
  })
  const notifications: unknown[] = []
  const unsubscribe = observer.subscribe((r) => notifications.push(r.data))

  qc.setQueryData(qk.me, USER)

  assert.deepEqual(observer.getCurrentResult().data, USER, 'login must reflect immediately')
  assert.deepEqual(notifications, [USER])
  unsubscribe()
})
