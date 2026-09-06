/**
 * PAXELBOX-61AG.3.32 — the automatic Paxel pickup rule.
 *
 * The whole business rule is one pure function, so it is tested as one: given the
 * instant a payment was verified, which appointment does the shop commit to?
 *
 *   verification <= cutoff  ->  SAME calendar day at the pickup time
 *   verification >  cutoff  ->  NEXT calendar day at the pickup time
 *
 * Every expectation below is written as an absolute UTC instant, deliberately.
 * Asserting on a local-time rendering would let the test agree with a buggy
 * implementation on a machine that happens to run in Asia/Jakarta — which is
 * exactly the failure mode (`Date#getHours()` reading the process timezone) that
 * already shifted every Paxel booking by seven hours once.
 */
import { execFileSync } from 'child_process';
import * as path from 'path';
import {
  PaxelPickupScheduler,
  resolveAutomaticPaxelPickupAt,
} from '../../src/modules/shipment/paxel-pickup-scheduler';
import { formatPaxelDatetime } from '../../src/modules/shipment/infrastructure/providers/paxel-datetime';
import {
  assertShippingConfigured,
  isValidTimeZone,
  loadShippingConfig,
  parseHhMm,
  PaxelAutoPickupConfig,
  ShippingConfig,
} from '../../src/modules/shipping/shipping.config';

/** The confirmed business policy. */
const POLICY: PaxelAutoPickupConfig = {
  enabled: true,
  timeZone: 'Asia/Jakarta',
  cutoffTime: '17:00',
  pickupTime: '19:00',
};

const resolve = (reference: string, policy: PaxelAutoPickupConfig = POLICY) =>
  resolveAutomaticPaxelPickupAt(new Date(reference), policy).toISOString();

// ======================================================== the stated rule =====

describe('the 17:00 cutoff / 19:00 pickup rule', () => {
  // The business's own worked examples, verbatim. 19:00 WIB is 12:00Z.
  describe.each([
    ['08:00', '2026-09-05T08:00:00+07:00', '2026-09-05T12:00:00.000Z'],
    ['09:00', '2026-09-05T09:00:00+07:00', '2026-09-05T12:00:00.000Z'],
    ['12:30', '2026-09-05T12:30:00+07:00', '2026-09-05T12:00:00.000Z'],
    ['16:59', '2026-09-05T16:59:00+07:00', '2026-09-05T12:00:00.000Z'],
    ['17:00', '2026-09-05T17:00:00+07:00', '2026-09-05T12:00:00.000Z'],
  ])('a payment verified at %s WIB', (_label, reference, expected) => {
    it("is picked up the SAME day at 19:00", () => {
      expect(resolve(reference)).toBe(expected);
    });
  });

  describe.each([
    ['17:01', '2026-09-05T17:01:00+07:00', '2026-09-06T12:00:00.000Z'],
    ['19:00', '2026-09-05T19:00:00+07:00', '2026-09-06T12:00:00.000Z'],
    ['22:00', '2026-09-05T22:00:00+07:00', '2026-09-06T12:00:00.000Z'],
    ['23:59', '2026-09-05T23:59:00+07:00', '2026-09-06T12:00:00.000Z'],
  ])('a payment verified at %s WIB', (_label, reference, expected) => {
    it('is picked up the NEXT day at 19:00', () => {
      expect(resolve(reference)).toBe(expected);
    });
  });

  it('treats 17:00 as included and 17:01 as excluded — the boundary is exactly there', () => {
    expect(resolve('2026-09-05T17:00:00+07:00')).toBe('2026-09-05T12:00:00.000Z');
    expect(resolve('2026-09-05T17:01:00+07:00')).toBe('2026-09-06T12:00:00.000Z');
  });

  it('compares at MINUTE granularity, so 17:00:59 still catches the same-day run', () => {
    // The business stated the boundary in minutes. Comparing seconds would shrink
    // "17:00 is included" to a one-second window, which is not what an
    // operational cutoff means.
    expect(resolve('2026-09-05T17:00:59+07:00')).toBe('2026-09-05T12:00:00.000Z');
  });

  it('produces an appointment strictly AFTER the verification, in every stated case', () => {
    for (const hour of Array.from({ length: 24 }, (_, h) => h)) {
      const reference = `2026-09-05T${String(hour).padStart(2, '0')}:30:00+07:00`;
      expect(new Date(resolve(reference)).getTime()).toBeGreaterThan(new Date(reference).getTime());
    }
  });
});

// ============================================ timezone, not process timezone ==

describe('the reference instant is read in the configured zone, never the process one', () => {
  it('evaluates a UTC-expressed instant using Jakarta local time', () => {
    // 18:00Z is already 01:00 the NEXT day in Jakarta — before the cutoff, so the
    // pickup is that (Jakarta) same day. A UTC-date calculation would answer the
    // 5th; the Jakarta answer is the 6th.
    expect(resolve('2026-09-05T18:00:00Z')).toBe('2026-09-06T12:00:00.000Z');
  });

  it('evaluates a UTC-expressed afternoon correctly across the cutoff', () => {
    // 11:00Z = 18:00 WIB, which is after the 17:00 cutoff -> next day.
    expect(resolve('2026-09-05T11:00:00Z')).toBe('2026-09-06T12:00:00.000Z');
    // 09:59Z = 16:59 WIB, still before it -> same day.
    expect(resolve('2026-09-05T09:59:00Z')).toBe('2026-09-05T12:00:00.000Z');
  });

  it('honours a zone that is NOT the machine timezone (proof the process TZ is unused)', () => {
    // On 2026-09-05 New York is EDT (UTC-4), so 19:00 local is 23:00Z. If the
    // implementation read the process clock this would be wrong on every machine
    // rather than only on non-Jakarta ones.
    const newYork: PaxelAutoPickupConfig = { ...POLICY, timeZone: 'America/New_York' };
    expect(resolve('2026-09-05T16:00:00-04:00', newYork)).toBe('2026-09-05T23:00:00.000Z');
    expect(resolve('2026-09-05T18:00:00-04:00', newYork)).toBe('2026-09-06T23:00:00.000Z');
  });

  it('lands on the right instant across a DST transition in the target zone', () => {
    // Verified 18:00 EDT on 31 Oct 2026 -> after cutoff -> 1 Nov, the day US
    // clocks fall back. 19:00 that day is EST (UTC-5), so 00:00Z on the 2nd.
    // A single-pass conversion using the offset at the REFERENCE would answer
    // 23:00Z on the 1st — an hour early, to a real courier.
    const newYork: PaxelAutoPickupConfig = { ...POLICY, timeZone: 'America/New_York' };
    expect(resolve('2026-10-31T18:00:00-04:00', newYork)).toBe('2026-11-02T00:00:00.000Z');
  });

  it('stays deterministic and valid for a zone far ahead of UTC', () => {
    const kiritimati: PaxelAutoPickupConfig = { ...POLICY, timeZone: 'Pacific/Kiritimati' }; // UTC+14
    const answer = resolve('2026-09-05T10:00:00+14:00', kiritimati);
    expect(answer).toBe('2026-09-05T05:00:00.000Z'); // 19:00 local on the 5th
    expect(Number.isNaN(new Date(answer).getTime())).toBe(false);
  });
});

// ================================================== calendar-date boundaries ==

describe('date boundaries are civil, not UTC', () => {
  it('rolls 23:59 on the last day of a month into the 1st of the next', () => {
    expect(resolve('2026-08-31T23:59:00+07:00')).toBe('2026-09-01T12:00:00.000Z');
  });

  it('rolls a 30-day month correctly', () => {
    expect(resolve('2026-09-30T17:01:00+07:00')).toBe('2026-10-01T12:00:00.000Z');
  });

  it('rolls the year at 31 December', () => {
    expect(resolve('2026-12-31T23:00:00+07:00')).toBe('2027-01-01T12:00:00.000Z');
  });

  it('handles the leap day', () => {
    expect(resolve('2028-02-28T20:00:00+07:00')).toBe('2028-02-29T12:00:00.000Z');
    expect(resolve('2028-02-29T20:00:00+07:00')).toBe('2028-03-01T12:00:00.000Z');
  });

  it('does not roll the day when the verification is before the cutoff, even late in UTC', () => {
    // 2026-09-05T16:00 WIB is 09:00Z — no UTC-day rollover anywhere near it.
    expect(resolve('2026-09-05T16:00:00+07:00')).toBe('2026-09-05T12:00:00.000Z');
  });
});

// ============================================================ configurability =

describe('the rule is configuration, not code', () => {
  it('honours a different cutoff', () => {
    const policy: PaxelAutoPickupConfig = { ...POLICY, cutoffTime: '09:00' };
    expect(resolve('2026-09-05T09:00:00+07:00', policy)).toBe('2026-09-05T12:00:00.000Z');
    expect(resolve('2026-09-05T09:01:00+07:00', policy)).toBe('2026-09-06T12:00:00.000Z');
  });

  it('honours a different pickup time', () => {
    const policy: PaxelAutoPickupConfig = { ...POLICY, pickupTime: '07:30' };
    // 07:30 WIB = 00:30Z. Note this pickup is BEFORE the cutoff and even before
    // the verification — allowed, because the cutoff is not a pickup bound.
    expect(resolve('2026-09-05T08:00:00+07:00', policy)).toBe('2026-09-05T00:30:00.000Z');
  });

  it('accepts midnight as a pickup time without rendering hour 24', () => {
    const policy: PaxelAutoPickupConfig = { ...POLICY, pickupTime: '00:00' };
    expect(resolve('2026-09-05T08:00:00+07:00', policy)).toBe('2026-09-04T17:00:00.000Z');
  });
});

// ================================================================= rejection ==

describe('invalid input is refused, never defaulted', () => {
  it('rejects an invalid timezone', () => {
    expect(() => resolve('2026-09-05T08:00:00+07:00', { ...POLICY, timeZone: 'Mars/Olympus' })).toThrow(
      /not a valid IANA timezone/,
    );
  });

  it('rejects an empty timezone rather than falling back to the process one', () => {
    expect(() => resolve('2026-09-05T08:00:00+07:00', { ...POLICY, timeZone: '' })).toThrow(/IANA timezone/);
  });

  it.each(['5:00', '17:0', '25:00', '17:60', '17.00', 'evening', ''])(
    'rejects %p as a cutoff time',
    (cutoffTime) => {
      expect(() => resolve('2026-09-05T08:00:00+07:00', { ...POLICY, cutoffTime })).toThrow(
        /PAXEL_PICKUP_CUTOFF_TIME must be HH:mm/,
      );
    },
  );

  it('rejects a malformed pickup time', () => {
    expect(() => resolve('2026-09-05T08:00:00+07:00', { ...POLICY, pickupTime: '7pm' })).toThrow(
      /PAXEL_PICKUP_DEFAULT_TIME must be HH:mm/,
    );
  });

  it('rejects an invalid reference instant', () => {
    expect(() => resolveAutomaticPaxelPickupAt(new Date('not a date'), POLICY)).toThrow(
      /valid payment verification time/,
    );
  });
});

// ==================================================== the injectable wrapper ==

describe('PaxelPickupScheduler', () => {
  const configWith = (autoPickup: PaxelAutoPickupConfig | undefined): ShippingConfig =>
    ({ paxel: { autoPickup } }) as unknown as ShippingConfig;

  it('is DISABLED when no automatic-pickup configuration exists at all', () => {
    const scheduler = new PaxelPickupScheduler(configWith(undefined));
    expect(scheduler.enabled).toBe(false);
    expect(() => scheduler.resolveIso(new Date())).toThrow(/disabled/);
  });

  it('is DISABLED when the flag is off, even with the times configured', () => {
    const scheduler = new PaxelPickupScheduler(configWith({ ...POLICY, enabled: false }));
    expect(scheduler.enabled).toBe(false);
    expect(() => scheduler.resolveIso(new Date())).toThrow(/PAXEL_AUTO_PICKUP_ENABLED/);
  });

  it('resolves the configured rule when enabled', () => {
    const scheduler = new PaxelPickupScheduler(configWith(POLICY));
    expect(scheduler.enabled).toBe(true);
    expect(scheduler.resolveIso(new Date('2026-09-05T17:01:00+07:00'))).toBe('2026-09-06T12:00:00.000Z');
  });
});

// ================================================== configuration validation ==

describe('parseHhMm / isValidTimeZone', () => {
  it.each([
    ['00:00', 0],
    ['09:05', 545],
    ['17:00', 1020],
    ['19:00', 1140],
    ['23:59', 1439],
    [' 17:00 ', 1020],
  ])('parses %p', (value, expected) => {
    expect(parseHhMm(value as string)).toBe(expected);
  });

  it.each(['24:00', '-1:00', '1:00', '170:0', 'abc', '', undefined])('refuses %p', (value) => {
    expect(parseHhMm(value as string | undefined)).toBeNull();
  });

  it.each(['Asia/Jakarta', 'UTC', 'America/New_York'])('accepts %p as a timezone', (tz) => {
    expect(isValidTimeZone(tz)).toBe(true);
  });

  it.each(['Mars/Olympus', 'WIB', '', ' ', undefined])('refuses %p as a timezone', (tz) => {
    expect(isValidTimeZone(tz as string | undefined)).toBe(false);
  });
});

describe('boot configuration', () => {
  const BASE_ENV = {
    PAXEL_AUTO_PICKUP_ENABLED: 'true',
    PAXEL_PICKUP_TIMEZONE: 'Asia/Jakarta',
    PAXEL_PICKUP_CUTOFF_TIME: '17:00',
    PAXEL_PICKUP_DEFAULT_TIME: '19:00',
  };

  it('reads the four variables into the Paxel config', () => {
    const config = loadShippingConfig(BASE_ENV as NodeJS.ProcessEnv);
    expect(config.paxel.autoPickup).toEqual({
      enabled: true,
      timeZone: 'Asia/Jakarta',
      cutoffTime: '17:00',
      pickupTime: '19:00',
    });
    expect(() => assertShippingConfigured(config)).not.toThrow();
  });

  it('is OFF, not defaulted, when nothing is configured', () => {
    const config = loadShippingConfig({} as NodeJS.ProcessEnv);
    expect(config.paxel.autoPickup?.enabled).toBe(false);
    // And an absent rule is not a boot error while the feature is off.
    expect(() => assertShippingConfigured(config)).not.toThrow();
  });

  it.each([
    ['PAXEL_PICKUP_TIMEZONE', /PAXEL_PICKUP_TIMEZONE/],
    ['PAXEL_PICKUP_CUTOFF_TIME', /PAXEL_PICKUP_CUTOFF_TIME/],
    ['PAXEL_PICKUP_DEFAULT_TIME', /PAXEL_PICKUP_DEFAULT_TIME/],
  ])('fails fast when %s is missing while the feature is on', (key, pattern) => {
    const env = { ...BASE_ENV, [key]: undefined } as unknown as NodeJS.ProcessEnv;
    expect(() => assertShippingConfigured(loadShippingConfig(env))).toThrow(pattern);
  });

  it('fails fast on an invalid timezone rather than silently using another', () => {
    const env = { ...BASE_ENV, PAXEL_PICKUP_TIMEZONE: 'Mars/Olympus' } as unknown as NodeJS.ProcessEnv;
    expect(() => assertShippingConfigured(loadShippingConfig(env))).toThrow(/PAXEL_PICKUP_TIMEZONE/);
  });

  it('fails fast on a malformed time', () => {
    const env = { ...BASE_ENV, PAXEL_PICKUP_CUTOFF_TIME: '5pm' } as unknown as NodeJS.ProcessEnv;
    expect(() => assertShippingConfigured(loadShippingConfig(env))).toThrow(/HH:mm/);
  });

  it('does NOT require the pickup time to fall after the cutoff', () => {
    // The business rule's own shape: the cutoff bounds VERIFICATION, not pickup.
    const env = { ...BASE_ENV, PAXEL_PICKUP_DEFAULT_TIME: '08:00' } as unknown as NodeJS.ProcessEnv;
    expect(() => assertShippingConfigured(loadShippingConfig(env))).not.toThrow();
  });
});

// ======================= the process timezone, proved in a real other process ==

/**
 * The in-process cases above pin the arithmetic. These pin the DEPLOYMENT
 * reality: production runs in UTC (no TZ is set in any Dockerfile) while a
 * developer machine runs Asia/Jakarta. Mutating process.env.TZ inside Jest does
 * not work - Date keeps the timezone the worker started with - so the timezone
 * is set where it is actually read, at process start, exactly as the existing
 * formatPaxelDatetime regression does.
 */
const BACKEND_ROOT = path.resolve(__dirname, '../..');
const SCHEDULER_MODULE = path.resolve(__dirname, '../../src/modules/shipment/paxel-pickup-scheduler.ts');
const PAXEL_DATETIME_MODULE = path.resolve(
  __dirname,
  '../../src/modules/shipment/infrastructure/providers/paxel-datetime.ts',
);

function runInTimezone(tz: string, snippet: string): Record<string, unknown> {
  const stdout = execFileSync(process.execPath, ['-r', 'tsx/cjs', '-e', snippet], {
    env: { ...process.env, TZ: tz },
    cwd: BACKEND_ROOT,
    encoding: 'utf8',
  });
  return JSON.parse(stdout.trim().split('\n').pop() as string) as Record<string, unknown>;
}

/** Resolves one reference through the REAL module, in a process running `tz`. */
function resolveUnderTimezone(tz: string, reference: string): { tz: string; iso: string; wire: string } {
  return runInTimezone(
    tz,
    `const { resolveAutomaticPaxelPickupAt } = require(${JSON.stringify(SCHEDULER_MODULE)});
     const { formatPaxelDatetime } = require(${JSON.stringify(PAXEL_DATETIME_MODULE)});
     const at = resolveAutomaticPaxelPickupAt(new Date(${JSON.stringify(reference)}), ${JSON.stringify(POLICY)});
     console.log(JSON.stringify({
       tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
       iso: at.toISOString(),
       wire: formatPaxelDatetime(at.toISOString()),
     }));`,
  ) as unknown as { tz: string; iso: string; wire: string };
}

describe('the resolver does not depend on the process timezone', () => {
  // 17:01 WIB on the 5th -> the NEXT day, 19:00 WIB.
  const REFERENCE = '2026-09-05T10:01:00.000Z';
  const EXPECTED_ISO = '2026-09-06T12:00:00.000Z';
  const EXPECTED_WIRE = '2026-09-06 19:00:00';

  it('answers identically on a developer host (Asia/Jakarta) and in the container (UTC)', () => {
    const jakarta = resolveUnderTimezone('Asia/Jakarta', REFERENCE);
    const utc = resolveUnderTimezone('UTC', REFERENCE);

    expect(jakarta.tz).toBe('Asia/Jakarta');
    expect(utc.tz).toBe('UTC');
    expect(jakarta.iso).toBe(EXPECTED_ISO);
    expect(utc.iso).toBe(EXPECTED_ISO);
    expect(utc.iso).toBe(jakarta.iso);
  }, 120_000);

  it('holds on the other side of the date line', () => {
    // UTC+14: a naive implementation reading the process clock would see a
    // different CALENDAR DAY here and book the pickup 24 hours out.
    expect(resolveUnderTimezone('Pacific/Kiritimati', REFERENCE).iso).toBe(EXPECTED_ISO);
  }, 120_000);

  it('reaches the Paxel wire format as the intended Jakarta wall clock', () => {
    // The full chain the courier actually sees: resolver -> ISO -> wire string.
    expect(resolveUnderTimezone('UTC', REFERENCE).wire).toBe(EXPECTED_WIRE);
    expect(formatPaxelDatetime(EXPECTED_ISO)).toBe(EXPECTED_WIRE);
  }, 120_000);
});
