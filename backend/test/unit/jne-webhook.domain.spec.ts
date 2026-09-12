import { ShipmentStatus } from '@prisma/client';
import {
  canonicalJson,
  currentJneRecord,
  historyEntryKey,
  isValidJneDate,
  JNE_MANDATORY_FIELDS,
  JNE_RECORD_ONLY_STATUSES,
  JNE_SUMMARY_STATUSES,
  JneWebhookPayload,
  JneWebhookRecord,
  mergeJneWebhook,
  parseJneWebhook,
  sanitizeMediaUrl,
} from '../../src/modules/shipment/domain/jne-webhook';
import { lookupProviderStatus } from '../../src/modules/shipment/shipment-status.mapper';
import { readJneWebhook, withJneWebhook, withoutCourierInternals } from '../../src/modules/shipment/shipment-metadata';

/** A complete, documented JNE V2 body (non-DELIVERED). */
const body = (over: Record<string, unknown> = {}) => ({
  awb: 'JNE0001',
  order_id: 'BMS-1',
  status: 'SUCCESS PICKUP',
  actual_weight: '1',
  actual_ongkir: '10000',
  service: 'REG',
  actual_sender_name: 'Bakso Mas Sular',
  actual_sender_address: 'Jl. Contoh 1',
  goods_desc: 'Bakso',
  origin_code: 'BDO10000',
  dest_code: 'CGK10000',
  history: [{ date: '2026-09-12 09:00:00', status: 'PICKED UP', status_code: 'PU1', status_desc: 'PICKED UP BY COURIER', location_code: '' }],
  ...over,
});

const ok = (input: unknown): JneWebhookPayload => {
  const result = parseJneWebhook(input);
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);
  return result.value;
};
const reason = (input: unknown): string => {
  const result = parseJneWebhook(input);
  if (result.ok) throw new Error('expected a rejection');
  return result.reason;
};

describe('JNE V2 payload validation', () => {
  it('accepts the documented payload and normalizes it', () => {
    const p = ok(body());
    expect(p).toMatchObject({ awb: 'JNE0001', orderId: 'BMS-1', status: 'SUCCESS PICKUP', service: 'REG', originCode: 'BDO10000', destCode: 'CGK10000' });
    expect(p.actualWeight).toEqual({ raw: '1', value: 1 });
    expect(p.actualOngkir).toEqual({ raw: '10000', value: 10000 });
    expect(p.delivery).toBeUndefined();
    expect(p.eventAt).toBe('2026-09-12 09:00:00'); // verbatim JNE date, never converted
  });

  it.each(JNE_MANDATORY_FIELDS)('G. %s is mandatory (absent or blank is rejected)', (field) => {
    expect(reason(body({ [field]: undefined }))).toBe(`${field} is required`);
    expect(reason(body({ [field]: '   ' }))).toBe(`${field} is required`);
  });

  it('G. wrong types are rejected, never coerced from objects', () => {
    expect(reason(body({ awb: { id: 1 } }))).toBe('awb must be a string');
    expect(reason('[]')).toBe('body must be a JSON object');
    expect(reason([body()])).toBe('body must be a JSON object');
  });

  it.each(JNE_SUMMARY_STATUSES)('accepts the documented summary status %s (case/spacing-insensitive)', (status) => {
    expect(ok(body({ status })).status).toBe(status);
    expect(ok(body({ status: `  ${status.toLowerCase().replace(' ', '  ')} ` })).status).toBe(status);
  });

  it.each(['PICKED UP', 'IN TRANSIT', 'CANCELLED', 'SUCCESS', ''])('H. rejects the undocumented status %p', (status) => {
    expect(reason(body({ status }))).toMatch(/status (must be one of|is required)/);
  });

  it.each([
    ['actual_weight', '-1'], ['actual_weight', 'abc'], ['actual_weight', '1,5'],
    ['actual_ongkir', '10.000,00'], ['actual_ongkir', '-5'],
  ])('rejects a non-numeric / negative %s (%s)', (field, value) => {
    expect(reason(body({ [field]: value }))).toBe(`${field} must be a non-negative number`);
  });

  it('accepts numeric fields as decimal strings or JSON numbers', () => {
    const p = ok(body({ actual_weight: 1.5, actual_ongkir: '10000.00' }));
    expect(p.actualWeight).toEqual({ raw: '1.5', value: 1.5 });
    expect(p.actualOngkir).toEqual({ raw: '10000.00', value: 10000 });
  });

  it('history must be an array of objects when provided; absent/null history is allowed', () => {
    expect(reason(body({ history: { date: '2026-09-12 09:00:00' } }))).toBe('history must be an array');
    expect(reason(body({ history: ['x'] }))).toBe('history[0] must be an object');
    expect(ok(body({ history: undefined })).history).toEqual([]);
    expect(ok(body({ history: null })).eventAt).toBeNull();
  });

  it.each([
    '2026/09/12 09:00:00', '2026-09-12T09:00:00', '2026-09-12 9:00:00', '2026-09-12', '12-09-2026 09:00:00',
    '2026-02-30 09:00:00', '2026-13-01 09:00:00', '2026-09-12 24:00:00', '2026-09-12 09:60:00', '',
  ])('I. rejects the malformed history date %p', (date) => {
    expect(reason(body({ history: [{ date, status: 'x', status_code: 'PU1', status_desc: 'x', location_code: '' }] }))).toMatch(/history\[0\]\.date/);
  });

  it('keeps JNE dates verbatim and never derives an instant from them (their zone is undocumented)', () => {
    expect(isValidJneDate('2024-02-29 23:59:59')).toBe(true);
    expect(isValidJneDate('2026-02-29 00:00:00')).toBe(false);
    const p = ok(body());
    expect(p.history[0].date).toBe('2026-09-12 09:00:00');
    // No ISO instant (and so no time-zone claim) anywhere in the normalized payload.
    expect(JSON.stringify(p)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    const record = mergeJneWebhook(undefined, p, new Date('2026-09-12T05:00:00Z')).next;
    expect(record.events[0]).toEqual(expect.not.objectContaining({ at: expect.anything() }));
    expect([record.lastEventAt, record.summaries[0].eventAt]).toEqual(['2026-09-12 09:00:00', '2026-09-12 09:00:00']);
  });

  it('non-DELIVERED payloads without delivery-only fields are accepted; delivery fields there are ignored', () => {
    expect(ok(body({ status: 'SHIPPED' })).delivery).toBeUndefined();
    expect(ok(body({ status: 'SHIPPED', receiver_name: 'X', photo: 'https://jne.example/p.jpg', cod_amount: '5' })).delivery).toBeUndefined();
  });

  it('D. DELIVERED: receiver, relation, signature and photo URLs are kept; P. cod_amount too', () => {
    const p = ok(body({
      status: 'DELIVERED',
      receiver_name: 'Budi', receiver_relation: 'SELF',
      signature: 'https://img.jne.example/sig/123.png', photo: 'http://img.jne.example/pod/123.jpg',
      cod_amount: '150000',
    }));
    expect(p.delivery).toEqual({
      receiverName: 'Budi', receiverRelation: 'SELF',
      signatureUrl: 'https://img.jne.example/sig/123.png', photoUrl: 'http://img.jne.example/pod/123.jpg',
      codAmount: { raw: '150000', value: 150000 },
    });
    expect(p.dropped).toEqual([]);
  });

  it('DELIVERED with unsafe media URLs or a malformed COD amount: dropped (named), the webhook still accepted', () => {
    const p = ok(body({
      status: 'DELIVERED', signature: 'javascript:alert(1)', photo: 'https://user:pass@evil.example/p.jpg', cod_amount: 'lots',
      latitude: '999', longitude: 'x',
    }));
    expect(p.delivery).toEqual({ receiverName: undefined, receiverRelation: undefined, signatureUrl: undefined, photoUrl: undefined, codAmount: undefined });
    expect(p.dropped.sort()).toEqual(['cod_amount', 'latitude', 'longitude', 'photo', 'signature']);
  });

  it('sanitizeMediaUrl allows absolute http(s) only, without credentials, bounded', () => {
    expect(sanitizeMediaUrl('https://a.example/x.png')).toBe('https://a.example/x.png');
    for (const bad of ['data:image/png;base64,AA', 'ftp://a.example/x', '/relative.png', 'https://u:p@a.example/x', `https://a.example/${'x'.repeat(2100)}`, '']) {
      expect(sanitizeMediaUrl(bad)).toBeNull();
    }
  });

  it('latitude/longitude are kept when valid', () => {
    const p = ok(body({ latitude: '-6.2', longitude: '106.8' }));
    expect([p.latitude, p.longitude]).toEqual([-6.2, 106.8]);
  });

  it('tolerates undocumented extra fields without storing them', () => {
    const p = ok(body({ some_future_field: 'x' }));
    expect(JSON.stringify(p)).not.toContain('some_future_field');
  });
});

describe('JNE history: identity, dedupe, chronology', () => {
  const h = (date: string, code = 'PU1', desc = 'PICKED UP BY COURIER') => ({ date, status: 'S', status_code: code, status_desc: desc, location_code: 'BDO' });

  it('M. an identical entry sent twice is one event; the same status_code at another date is a different event', () => {
    const p = ok(body({ history: [h('2026-09-12 09:00:00'), h('2026-09-12 09:00:00'), h('2026-09-12 11:00:00')] }));
    expect(p.history).toHaveLength(2);
    expect(new Set(p.history.map((e) => e.statusCode))).toEqual(new Set(['PU1']));
  });

  it('O. entries are stored chronologically whatever order JNE sends; eventAt is the latest', () => {
    const p = ok(body({ history: [h('2026-09-12 15:00:00', 'D1', 'DELIVERED'), h('2026-09-12 09:00:00'), h('2026-09-12 12:00:00', 'T1', 'IN TRANSIT')] }));
    expect(p.history.map((e) => e.statusCode)).toEqual(['PU1', 'T1', 'D1']);
    expect(p.eventAt).toBe('2026-09-12 15:00:00');
  });

  it('unknown status codes are preserved verbatim, not dropped or mapped', () => {
    const p = ok(body({ history: [h('2026-09-12 09:00:00', 'ZZ9', 'SOMETHING NEW')] }));
    expect(p.history[0]).toMatchObject({ statusCode: 'ZZ9', statusDesc: 'SOMETHING NEW' });
  });

  it('keys and the webhook fingerprint are deterministic across retries', () => {
    const a = ok(body());
    const b = ok(JSON.parse(JSON.stringify(body())));
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.history[0].key).toBe(historyEntryKey({ date: '2026-09-12 09:00:00', status: 'PICKED UP', statusCode: 'PU1', statusDesc: 'PICKED UP BY COURIER', locationCode: '' }));
    expect(ok(body({ status: 'SHIPPED' })).fingerprint).not.toBe(a.fingerprint);
  });
});

describe('JNE → internal status mapping (shared ShipmentStatusMapper vocabulary)', () => {
  it.each([
    ['SUCCESS PICKUP', ShipmentStatus.PICKED_UP],
    ['SHIPPED', ShipmentStatus.IN_TRANSIT],
    ['DELIVERED', ShipmentStatus.DELIVERED],
    ['RETURN TO SHIPPER', ShipmentStatus.FAILED],
  ])('%s → %s', (status, mapped) => {
    expect(lookupProviderStatus('jne', status)).toBe(mapped);
  });

  it('FAILED PICKUP and SHIPMENT PROBLEM have no internal state: unmapped, record-only', () => {
    expect(lookupProviderStatus('jne', 'FAILED PICKUP')).toBeUndefined();
    expect(lookupProviderStatus('jne', 'SHIPMENT PROBLEM')).toBeUndefined();
    expect([...JNE_RECORD_ONLY_STATUSES].sort()).toEqual(['FAILED PICKUP', 'SHIPMENT PROBLEM']);
  });

  it('Paxel vocabulary is untouched by the JNE additions', () => {
    expect(lookupProviderStatus('paxel', 'SUCCESS PICKUP')).toBeUndefined();
    expect(lookupProviderStatus('paxel', 'PDO')).toBe(ShipmentStatus.DELIVERED);
  });
});

describe('merge: idempotent record of everything JNE reported', () => {
  const t0 = new Date('2026-09-12T05:00:00Z');

  it('L. merging the same payload twice changes nothing the second time', () => {
    const p = ok(body());
    const first = mergeJneWebhook(undefined, p, t0);
    expect(first).toMatchObject({ changed: true, addedEvents: 1 });
    // Round-trip through JSON as JSONB would (key order is not preserved).
    const stored = JSON.parse(canonicalJson(first.next));
    const second = mergeJneWebhook(stored, ok(body()), new Date('2026-09-12T06:00:00Z'));
    expect(second).toMatchObject({ changed: false, addedEvents: 0 });
    expect(second.next.lastReceivedAt).toBe(t0.toISOString());
  });

  it('Q. actual weight/ongkir are recorded as courier figures; an older webhook never overwrites newer ones', () => {
    const newer = mergeJneWebhook(undefined, ok(body({ actual_weight: '2', actual_ongkir: '22000', history: [{ date: '2026-09-12 12:00:00', status: 'T', status_code: 'T1', status_desc: 'TRANSIT', location_code: '' }] })), t0).next;
    expect(newer.actual).toEqual({ weight: 2, weightRaw: '2', ongkir: 22000, ongkirRaw: '22000', service: 'REG' });
    const afterOld = mergeJneWebhook(newer, ok(body({ actual_weight: '1', actual_ongkir: '10000' })), t0);
    expect(afterOld.next.actual.ongkir).toBe(22000); // not rolled back
    expect(afterOld.addedEvents).toBe(1); // but the older event is still preserved
    expect(afterOld.next.events.map((e) => e.statusCode)).toEqual(['PU1', 'T1']);
  });

  it('E. a status that moves nothing is still preserved as a summary line', () => {
    const r = mergeJneWebhook(undefined, ok(body({ status: 'SHIPMENT PROBLEM' })), t0).next;
    expect(r.summaries).toEqual([{ status: 'SHIPMENT PROBLEM', eventAt: '2026-09-12 09:00:00', firstReceivedAt: t0.toISOString() }]);
  });

  it('a stored v1 record (WIB-converted times, never released) is upgraded: events kept, converted times dropped', () => {
    const v1 = {
      version: 1,
      lastReceivedAt: '2026-09-12T05:00:00.000Z',
      lastEventAt: '2026-09-12T02:00:00.000Z',
      lastAppliedEventAt: '2026-09-12T02:00:00.000Z',
      lastAppliedStatus: 'SUCCESS PICKUP',
      actual: { weight: 1, weightRaw: '1', ongkir: 10000, ongkirRaw: '10000', service: 'REG' },
      route: { originCode: 'BDO10000', destCode: 'CGK10000', senderName: 's', senderAddress: 'a', goodsDesc: 'g' },
      summaries: [{ status: 'SUCCESS PICKUP', eventAt: '2026-09-12T02:00:00.000Z', firstReceivedAt: '2026-09-12T05:00:00.000Z' }],
      events: [{ key: ok(body()).history[0].key, date: '2026-09-12 09:00:00', at: '2026-09-12T02:00:00.000Z', status: 'PICKED UP', statusCode: 'PU1', statusDesc: 'PICKED UP BY COURIER', locationCode: '' }],
    } as unknown as JneWebhookRecord;
    const upgraded = currentJneRecord(v1)!;
    expect(upgraded).toMatchObject({ version: 2, lastEventAt: '2026-09-12 09:00:00', lastAppliedEventAt: null, lastAppliedStatus: 'SUCCESS PICKUP' });
    expect(upgraded.events[0]).not.toHaveProperty('at');
    expect(upgraded.summaries[0].eventAt).toBeNull();
    // The same event is recognised by its key; persisting the upgrade is the only change.
    const merged = mergeJneWebhook(v1, ok(body()), new Date('2026-09-12T06:00:00Z'));
    expect(merged).toMatchObject({ addedEvents: 0, changed: true });
    expect(merged.next.version).toBe(2);
  });
});

describe('metadata: namespaced, merged, and never shown to customers', () => {
  it('writes the record under jne.webhook without losing the pickup slot or other couriers', () => {
    const record = mergeJneWebhook(undefined, ok(body()), new Date()).next;
    const existing = { jne: { pickupDatetime: '2026-09-12T10:00:00.000Z' }, paxel: { pickupDatetime: 'x' }, error: 'e' };
    const merged = withJneWebhook(existing, record) as Record<string, any>;
    expect(merged.jne.pickupDatetime).toBe('2026-09-12T10:00:00.000Z');
    expect(merged.paxel).toEqual({ pickupDatetime: 'x' });
    expect(merged.error).toBe('e');
    expect(readJneWebhook(merged)?.actual.ongkir).toBe(10000);
  });

  it('the customer view drops jne.webhook and keeps the rest', () => {
    const record = mergeJneWebhook(undefined, ok(body({ status: 'DELIVERED', receiver_name: 'Budi' })), new Date()).next;
    const stored = withJneWebhook({ jne: { pickupDatetime: 'p' } }, record);
    expect(withoutCourierInternals(stored as never)).toEqual({ jne: { pickupDatetime: 'p' } });
    expect(withoutCourierInternals(withJneWebhook(null, record) as never)).toEqual({});
    expect(withoutCourierInternals(null)).toBeNull();
    expect(withoutCourierInternals({ jne: { pickupDatetime: 'p' } })).toEqual({ jne: { pickupDatetime: 'p' } });
  });
});
