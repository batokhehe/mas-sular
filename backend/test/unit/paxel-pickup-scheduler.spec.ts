/**
 * PAXELBOX-61AG.3.32 / P1 #13 — the shop-wide courier pickup rule
 * (cut-off 15:00 WIB, pickup 17:00 WIB).
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
  DEFAULT_PICKUP_POLICY,
  isValidTimeZone,
  loadShippingConfig,
  parseHhMm,
  PaxelAutoPickupConfig,
  PickupPolicy,
  ShippingConfig,
} from '../../src/modules/shipping/shipping.config';

/** The confirmed business policy (P1 #13): cut-off 15:00 WIB, pickup 17:00 WIB. */
const POLICY: PaxelAutoPickupConfig = {
  enabled: true,
  timeZone: 'Asia/Jakarta',
  cutoffTime: '15:00',
  pickupTime: '17:00',
};

const resolve = (reference: string, policy: PickupPolicy = POLICY) =>
  resolveAutomaticPaxelPickupAt(new Date(reference), policy).toISOString();

// 17:00 WIB (UTC+7, no DST) is 10:00Z. Every same-day answer below is 10:00Z on
// the verification's own Jakarta date; every next-day answer is 10:00Z the day after.

// ======================================================== the stated rule =====

describe('the 15:00 cut-off / 17:00 pickup rule', () => {
  it('IS the default pickup policy - the single source of truth in code', () => {
    expect(DEFAULT_PICKUP_POLICY).toEqual({ timeZone: 'Asia/Jakarta', cutoffTime: '15:00', pickupTime: '17:00' });
    expect(Object.isFrozen(DEFAULT_PICKUP_POLICY)).toBe(true);
  });

  describe.each([
    ['08:00', '2026-09-05T08:00:00+07:00', '2026-09-05T10:00:00.000Z'],
    ['09:00', '2026-09-05T09:00:00+07:00', '2026-09-05T10:00:00.000Z'],
    ['12:30', '2026-09-05T12:30:00+07:00', '2026-09-05T10:00:00.000Z'],
    ['14:59', '2026-09-05T14:59:00+07:00', '2026-09-05T10:00:00.000Z'],
    ['15:00', '2026-09-05T15:00:00+07:00', '2026-09-05T10:00:00.000Z'],
  ])('a payment verified at %s WIB', (_label, reference, expected) => {
    it('is picked up the SAME day at 17:00', () => {
      expect(resolve(reference)).toBe(expected);
    });
  });

  describe.each([
    ['15:01', '2026-09-05T15:01:00+07:00', '2026-09-06T10:00:00.000Z'],
    ['16:59', '2026-09-05T16:59:00+07:00', '2026-09-06T10:00:00.000Z'],
    ['17:00', '2026-09-05T17:00:00+07:00', '2026-09-06T10:00:00.000Z'],
    ['19:00', '2026-09-05T19:00:00+07:00', '2026-09-06T10:00:00.000Z'],
    ['22:00', '2026-09-05T22:00:00+07:00', '2026-09-06T10:00:00.000Z'],
    ['23:59', '2026-09-05T23:59:00+07:00', '2026-09-06T10:00:00.000Z'],
  ])('a payment verified at %s WIB', (_label, reference, expected) => {
    it('is picked up the NEXT day at 17:00', () => {
      expect(resolve(reference)).toBe(expected);
    });
  });

  it('14:59 is before the cut-off, 15:00 is included, 15:01 is after - the boundary is exactly there', () => {
    expect(resolve('2026-09-05T14:59:00+07:00')).toBe('2026-09-05T10:00:00.000Z');
    expect(resolve('2026-09-05T15:00:00+07:00')).toBe('2026-09-05T10:00:00.000Z');
    expect(resolve('2026-09-05T15:01:00+07:00')).toBe('2026-09-06T10:00:00.000Z');
  });

  it('never conflates the cut-off with the pickup: a payment verified AT 17:00 misses today', () => {
    // 17:00 is the PICKUP time, not the cut-off. Under the old rule (cut-off
    // 17:00) this verification caught today's run; under 15:00 it must not.
    expect(resolve('2026-09-05T17:00:00+07:00')).toBe('2026-09-06T10:00:00.000Z');
    // ...and the old rule's last same-day minute is now a next-day case too.
    expect(resolve('2026-09-05T16:59:00+07:00')).toBe('2026-09-06T10:00:00.000Z');
  });

  it('compares at MINUTE granularity, so 15:00:59 still catches the same-day run', () => {
    // The business stated the boundary in minutes. Comparing seconds would shrink
    // "15:00 is included" to a one-second window, which is not what an
    // operational cutoff means.
    expect(resolve('2026-09-05T15:00:59+07:00')).toBe('2026-09-05T10:00:00.000Z');
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
    expect(resolve('2026-09-05T18:00:00Z')).toBe('2026-09-06T10:00:00.000Z');
  });

  it('evaluates UTC-expressed instants correctly on both sides of the 15:00 WIB cut-off', () => {
    // 07:59Z = 14:59 WIB -> before the cut-off -> same day.
    expect(resolve('2026-09-05T07:59:00Z')).toBe('2026-09-05T10:00:00.000Z');
    // 08:00Z = 15:00 WIB -> the cut-off minute itself -> same day.
    expect(resolve('2026-09-05T08:00:00Z')).toBe('2026-09-05T10:00:00.000Z');
    // 08:01Z = 15:01 WIB -> after the cut-off -> next day.
    expect(resolve('2026-09-05T08:01:00Z')).toBe('2026-09-06T10:00:00.000Z');
    // 11:00Z = 18:00 WIB -> after the cut-off -> next day.
    expect(resolve('2026-09-05T11:00:00Z')).toBe('2026-09-06T10:00:00.000Z');
  });

  it('honours a zone that is NOT the machine timezone (proof the process TZ is unused)', () => {
    // On 2026-09-05 New York is EDT (UTC-4), so 17:00 local is 21:00Z. If the
    // implementation read the process clock this would be wrong on every machine
    // rather than only on non-Jakarta ones.
    const newYork: PaxelAutoPickupConfig = { ...POLICY, timeZone: 'America/New_York' };
    expect(resolve('2026-09-05T14:00:00-04:00', newYork)).toBe('2026-09-05T21:00:00.000Z');
    expect(resolve('2026-09-05T16:00:00-04:00', newYork)).toBe('2026-09-06T21:00:00.000Z');
  });

  it('lands on the right instant across a DST transition in the target zone', () => {
    // Verified 18:00 EDT on 31 Oct 2026 -> after cutoff -> 1 Nov, the day US
    // clocks fall back. 17:00 that day is EST (UTC-5), so 22:00Z on the 1st.
    // A single-pass conversion using the offset at the REFERENCE would answer
    // 21:00Z — an hour early, to a real courier.
    const newYork: PaxelAutoPickupConfig = { ...POLICY, timeZone: 'America/New_York' };
    expect(resolve('2026-10-31T18:00:00-04:00', newYork)).toBe('2026-11-01T22:00:00.000Z');
  });

  it('stays deterministic and valid for a zone far ahead of UTC', () => {
    const kiritimati: PaxelAutoPickupConfig = { ...POLICY, timeZone: 'Pacific/Kiritimati' }; // UTC+14
    const answer = resolve('2026-09-05T10:00:00+14:00', kiritimati);
    expect(answer).toBe('2026-09-05T03:00:00.000Z'); // 17:00 local on the 5th
    expect(Number.isNaN(new Date(answer).getTime())).toBe(false);
  });
});

// ================================================== calendar-date boundaries ==

describe('date boundaries are civil, not UTC', () => {
  it('rolls 23:59 on the last day of a month into the 1st of the next', () => {
    expect(resolve('2026-08-31T23:59:00+07:00')).toBe('2026-09-01T10:00:00.000Z');
  });

  it('rolls a 30-day month correctly', () => {
    expect(resolve('2026-09-30T15:01:00+07:00')).toBe('2026-10-01T10:00:00.000Z');
  });

  it('rolls the year at 31 December', () => {
    expect(resolve('2026-12-31T23:00:00+07:00')).toBe('2027-01-01T10:00:00.000Z');
  });

  it('handles the leap day', () => {
    expect(resolve('2028-02-28T20:00:00+07:00')).toBe('2028-02-29T10:00:00.000Z');
    expect(resolve('2028-02-29T20:00:00+07:00')).toBe('2028-03-01T10:00:00.000Z');
  });

  it('does not roll the day when the verification is before the cutoff, even late in UTC', () => {
    // 2026-09-05T14:00 WIB is 07:00Z — no UTC-day rollover anywhere near it.
    expect(resolve('2026-09-05T14:00:00+07:00')).toBe('2026-09-05T10:00:00.000Z');
  });
});

// ============================================================ configurability =

describe('the rule can be overridden per environment', () => {
  it('honours a different cutoff', () => {
    const policy: PaxelAutoPickupConfig = { ...POLICY, cutoffTime: '09:00' };
    expect(resolve('2026-09-05T09:00:00+07:00', policy)).toBe('2026-09-05T10:00:00.000Z');
    expect(resolve('2026-09-05T09:01:00+07:00', policy)).toBe('2026-09-06T10:00:00.000Z');
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

describe('invalid input reaching the resolver is refused, never defaulted', () => {
  // Defaulting happens ONCE, in loadPickupPolicy, for UNSET values. A value that
  // reaches the resolver malformed is a bug or a bad override, and is refused.
  it('rejects an invalid timezone', () => {
    expect(() => resolve('2026-09-05T08:00:00+07:00', { ...POLICY, timeZone: 'Mars/Olympus' })).toThrow(
      /not a valid IANA timezone/,
    );
  });

  it('rejects an empty timezone rather than falling back to the process one', () => {
    expect(() => resolve('2026-09-05T08:00:00+07:00', { ...POLICY, timeZone: '' })).toThrow(/IANA timezone/);
  });

  it.each(['5:00', '15:0', '25:00', '15:60', '15.00', 'afternoon', ''])(
    'rejects %p as a cutoff time',
    (cutoffTime) => {
      expect(() => resolve('2026-09-05T08:00:00+07:00', { ...POLICY, cutoffTime })).toThrow(
        /PAXEL_PICKUP_CUTOFF_TIME must be HH:mm/,
      );
    },
  );

  it('rejects a malformed pickup time', () => {
    expect(() => resolve('2026-09-05T08:00:00+07:00', { ...POLICY, pickupTime: '5pm' })).toThrow(
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
  const configWith = (autoPickup: PaxelAutoPickupConfig | undefined, pickupPolicy?: PickupPolicy): ShippingConfig =>
    ({ paxel: { autoPickup }, pickupPolicy }) as unknown as ShippingConfig;

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
    expect(scheduler.resolveIso(new Date('2026-09-05T15:01:00+07:00'))).toBe('2026-09-06T10:00:00.000Z');
  });

  describe('resolvePolicyIso - the shop-wide slot (used for JNE)', () => {
    it("resolves the shared rule even while Paxel's automatic booking is OFF", () => {
      // The switch decides whether Paxel books on its own - not the shop's pickup time.
      const scheduler = new PaxelPickupScheduler(configWith({ ...POLICY, enabled: false }, DEFAULT_PICKUP_POLICY));
      expect(scheduler.resolvePolicyIso(new Date('2026-09-05T14:59:00+07:00'))).toBe('2026-09-05T10:00:00.000Z');
      expect(scheduler.resolvePolicyIso(new Date('2026-09-05T15:01:00+07:00'))).toBe('2026-09-06T10:00:00.000Z');
    });

    it('falls back to the business rule when a config carries no policy, never to "no rule"', () => {
      const scheduler = new PaxelPickupScheduler(configWith(undefined, undefined));
      expect(scheduler.resolvePolicyIso(new Date('2026-09-05T15:00:00+07:00'))).toBe('2026-09-05T10:00:00.000Z');
    });

    it('agrees with the Paxel path for the same verification (one rule, two couriers)', () => {
      const scheduler = new PaxelPickupScheduler(configWith(POLICY, DEFAULT_PICKUP_POLICY));
      const verifiedAt = new Date('2026-09-05T15:01:00+07:00');
      expect(scheduler.resolvePolicyIso(verifiedAt)).toBe(scheduler.resolveIso(verifiedAt));
    });
  });
});

// ================================================== configuration validation ==

describe('parseHhMm / isValidTimeZone', () => {
  it.each([
    ['00:00', 0],
    ['09:05', 545],
    ['15:00', 900],
    ['17:00', 1020],
    ['23:59', 1439],
    [' 15:00 ', 900],
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
  const BASE_ENV = { PAXEL_AUTO_PICKUP_ENABLED: 'true' };

  it('with nothing but the switch set, both couriers get the 15:00 / 17:00 Asia/Jakarta rule', () => {
    const config = loadShippingConfig(BASE_ENV as NodeJS.ProcessEnv);
    expect(config.pickupPolicy).toEqual(DEFAULT_PICKUP_POLICY);
    expect(config.paxel.autoPickup).toEqual({ enabled: true, ...DEFAULT_PICKUP_POLICY });
    expect(() => assertShippingConfigured(config)).not.toThrow();
  });

  it("Paxel's copy and the shared policy come from ONE computation, never two", () => {
    const config = loadShippingConfig({
      ...BASE_ENV,
      PAXEL_PICKUP_CUTOFF_TIME: '14:30',
    } as unknown as NodeJS.ProcessEnv);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { enabled, ...paxelTimes } = config.paxel.autoPickup!;
    expect(paxelTimes).toEqual(config.pickupPolicy);
    expect(config.pickupPolicy?.cutoffTime).toBe('14:30');
  });

  it('with nothing configured at all: Paxel auto-booking OFF, the shop rule still defined', () => {
    const config = loadShippingConfig({} as NodeJS.ProcessEnv);
    expect(config.paxel.autoPickup?.enabled).toBe(false);
    expect(config.pickupPolicy).toEqual(DEFAULT_PICKUP_POLICY);
    expect(() => assertShippingConfigured(config)).not.toThrow();
  });

  it.each([
    ['PAXEL_PICKUP_TIMEZONE', 'timeZone', 'Asia/Jakarta'],
    ['PAXEL_PICKUP_CUTOFF_TIME', 'cutoffTime', '15:00'],
    ['PAXEL_PICKUP_DEFAULT_TIME', 'pickupTime', '17:00'],
  ] as const)('falls back to the business rule when %s is unset or blank', (key, field, expected) => {
    for (const value of [undefined, '', '   ']) {
      const config = loadShippingConfig({ ...BASE_ENV, [key]: value } as unknown as NodeJS.ProcessEnv);
      expect(config.pickupPolicy?.[field]).toBe(expected);
      expect(config.paxel.autoPickup?.[field]).toBe(expected);
      expect(() => assertShippingConfigured(config)).not.toThrow();
    }
  });

  it('an explicit override wins over the default', () => {
    const config = loadShippingConfig({
      ...BASE_ENV,
      PAXEL_PICKUP_TIMEZONE: 'Asia/Makassar',
      PAXEL_PICKUP_CUTOFF_TIME: '14:00',
      PAXEL_PICKUP_DEFAULT_TIME: '16:00',
    } as unknown as NodeJS.ProcessEnv);
    expect(config.pickupPolicy).toEqual({ timeZone: 'Asia/Makassar', cutoffTime: '14:00', pickupTime: '16:00' });
  });

  it('fails fast on an invalid timezone rather than silently using another', () => {
    const env = { ...BASE_ENV, PAXEL_PICKUP_TIMEZONE: 'Mars/Olympus' } as unknown as NodeJS.ProcessEnv;
    expect(() => assertShippingConfigured(loadShippingConfig(env))).toThrow(/PAXEL_PICKUP_TIMEZONE/);
  });

  it("fails fast on a bad override even while Paxel's auto-booking is OFF (JNE uses the rule too)", () => {
    const env = { PAXEL_PICKUP_TIMEZONE: 'Mars/Olympus' } as unknown as NodeJS.ProcessEnv;
    expect(() => assertShippingConfigured(loadShippingConfig(env))).toThrow(/PAXEL_PICKUP_TIMEZONE/);
  });

  it('fails fast on a malformed time', () => {
    const env = { ...BASE_ENV, PAXEL_PICKUP_CUTOFF_TIME: '3pm' } as unknown as NodeJS.ProcessEnv;
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
  // 15:01 WIB on the 5th (one minute past the cut-off) -> the NEXT day, 17:00 WIB.
  const REFERENCE = '2026-09-05T08:01:00.000Z';
  const EXPECTED_ISO = '2026-09-06T10:00:00.000Z';
  const EXPECTED_WIRE = '2026-09-06 17:00:00';

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
