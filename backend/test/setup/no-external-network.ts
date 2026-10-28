/**
 * Unit-test network tripwire.
 *
 * Every courier and payment transport goes through the global `fetch`, so a unit
 * test that enables a provider and forgets to inject its HTTP double would talk to
 * the real vendor - for Paxel that means a real (sandbox or production) booking.
 * Here `fetch` only reaches hosts no real vendor lives on: loopback and the
 * RFC 2606 reserved names (`.test`, `.invalid`, `.example`, `.localhost`). Anything
 * else is refused before a socket is opened.
 *
 * Only the host is reported: the URL path or query could carry an identifier.
 * Tests that stub `fetch` with jest.spyOn still work - the spy wraps this guard.
 */
const realFetch = globalThis.fetch;

function isOfflineHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '::1' ||
    /\.(test|invalid|example|localhost)$/.test(h)
  );
}

function hostnameOf(input: Parameters<typeof fetch>[0]): string {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(raw).hostname;
  } catch {
    return '';
  }
}

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const hostname = hostnameOf(input);
  if (!isOfflineHost(hostname)) {
    throw new Error(`Unit tests must not reach external hosts (blocked fetch to ${hostname || 'an unparseable URL'})`);
  }
  return realFetch(input, init);
}) as typeof fetch;
