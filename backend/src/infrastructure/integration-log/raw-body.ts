/**
 * The inbound request body EXACTLY as received, for the SUPER_ADMIN Integration Logs
 * detail view. Nest keeps the unparsed bytes on `req.rawBody` when the app is created
 * with `rawBody: true` (main.ts); anything else (a unit test calling the handler
 * directly, a body type Nest does not parse) yields null rather than a reconstruction.
 */
export function rawBodyText(req: { rawBody?: unknown } | undefined): string | null {
  const raw = req?.rawBody;
  return Buffer.isBuffer(raw) ? raw.toString('utf8') : null;
}

/**
 * The response body Nest sends for a handler's returned object: Express `res.json`
 * serializes with JSON.stringify (no replacer, no spacing configured in this app).
 */
export function sentJsonBody(body: unknown): string | null {
  return body === undefined ? null : JSON.stringify(body);
}
