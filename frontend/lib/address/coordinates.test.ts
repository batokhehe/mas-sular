import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isUsableCoordinate, coordinateFieldsForUpdate } from './coordinates.ts'

// PAXELBOX-61AG.3.8.6 — the client must stop manufacturing 0,0 on an edit.
//
// Context: the address form has no map picker, so its hidden coordinate fields
// echo whatever is stored. Legacy rows hold 0,0, the server now rejects that pair
// on update (61AG.3.7), and the echo therefore made those addresses uneditable.

test('a real coordinate is usable', () => {
  assert.equal(isUsableCoordinate(-6.9207623, 107.6096701), true)
  assert.equal(isUsableCoordinate(51.5074, -0.1278), true) // no invented country box
})

test('0,0 is NOT usable — it is the form placeholder, not a location', () => {
  assert.equal(isUsableCoordinate(0, 0), false)
})

test('a single axis at zero IS usable — only the pair is the placeholder', () => {
  assert.equal(isUsableCoordinate(0, 107.6), true)
  assert.equal(isUsableCoordinate(-6.9, 0), true)
})

test('out-of-range coordinates are not usable', () => {
  assert.equal(isUsableCoordinate(-91, 107), false)
  assert.equal(isUsableCoordinate(91, 107), false)
  assert.equal(isUsableCoordinate(-6.9, -181), false)
  assert.equal(isUsableCoordinate(-6.9, 181), false)
})

test('non-numbers are not usable', () => {
  assert.equal(isUsableCoordinate(undefined, undefined), false)
  assert.equal(isUsableCoordinate(null, null), false)
  assert.equal(isUsableCoordinate(Number.NaN, 107), false)
  assert.equal(isUsableCoordinate(Number.POSITIVE_INFINITY, 107), false)
})

test('Prisma Decimal strings coerce, because the API returns coordinates as strings', () => {
  // GET /users/me/addresses serialises Decimal(10,7) as a string.
  assert.equal(isUsableCoordinate('-6.9207623', '107.6096701'), true)
  assert.equal(isUsableCoordinate('0', '0'), false)
})

test('an update carries a real coordinate through unchanged', () => {
  assert.deepEqual(coordinateFieldsForUpdate(-6.9207623, 107.6096701), {
    latitude: -6.9207623,
    longitude: 107.6096701,
  })
})

test('an update OMITS the fields for a legacy 0,0 address', () => {
  const fields = coordinateFieldsForUpdate(0, 0)
  assert.deepEqual(fields, {})
  assert.equal('latitude' in fields, false)
  assert.equal('longitude' in fields, false)
})

test('omission never becomes an explicit zero', () => {
  // The exact regression: the payload must not contain latitude:0 / longitude:0.
  const payload = { label: 'Rumah', ...coordinateFieldsForUpdate(0, 0) } as Record<string, unknown>
  assert.equal(JSON.stringify(payload).includes('latitude'), false)
  assert.equal(payload.latitude, undefined)
  assert.equal(payload.longitude, undefined)
})
