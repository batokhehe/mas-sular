/**
 * PAXELBOX-61AG.3.8.6 — what counts as a usable coordinate on the client.
 *
 * Mirrors the server's `isPersistableCoordinate` (backend geocoding.service.ts)
 * so both ends agree on the one question that matters: is this a real place, or
 * the address form's placeholder?
 *
 * `(0, 0)` is rejected explicitly. It is a valid point in the Gulf of Guinea, but
 * in this system it is what an address gets when nobody picked a location, and
 * the server now REJECTS it on update (PAXELBOX-61AG.3.7). Sending it back would
 * make an otherwise ordinary edit — changing a phone number on a legacy address —
 * fail validation.
 */
export function isUsableCoordinate(lat: unknown, lng: unknown): boolean {
  const la = typeof lat === 'string' ? Number(lat) : lat
  const lo = typeof lng === 'string' ? Number(lng) : lng
  if (typeof la !== 'number' || typeof lo !== 'number') return false
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return false
  if (la < -90 || la > 90) return false
  if (lo < -180 || lo > 180) return false
  if (la === 0 && lo === 0) return false
  return true
}

/**
 * The latitude/longitude an UPDATE should carry.
 *
 * Returns the pair only when the stored one is real. When it is not — a legacy
 * `0,0` row, or anything else unusable — the fields are OMITTED entirely rather
 * than sent as zeros: omitted means "leave the pin alone", whereas `0,0` means
 * "move the pin to nowhere" and is refused by the server.
 */
export function coordinateFieldsForUpdate(
  lat: unknown,
  lng: unknown,
): { latitude: number; longitude: number } | Record<string, never> {
  if (!isUsableCoordinate(lat, lng)) return {}
  return { latitude: Number(lat), longitude: Number(lng) }
}
