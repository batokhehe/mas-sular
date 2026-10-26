/**
 * The approved courier pickup policy (Phase 2): cut-off 15:00 WIB (15:00 itself is
 * past the cut-off), pickup 17:00 WIB, no Saturday/Sunday pickups.
 *
 * Reference week: Mon 2 Nov 2026 .. Mon 9 Nov 2026. Every expectation is an
 * absolute UTC instant - 17:00 WIB (UTC+7, no DST) is 10:00Z - so a buggy
 * implementation cannot agree with the test merely because the machine runs in
 * Asia/Jakarta.
 */
import { execFileSync } from 'child_process';
import * as path from 'path';
import { resolvePickupSchedule, PickupScheduleReason } from '../../src/modules/shipping/pickup-schedule';
import { DEFAULT_PICKUP_POLICY, PickupPolicy } from '../../src/modules/shipping/shipping.config';

const POLICY: PickupPolicy = { timeZone: 'Asia/Jakarta', cutoffTime: '15:00', pickupTime: '17:00' };

const at = (reference: string) => resolvePickupSchedule(new Date(reference), POLICY);
const pickup = (reference: string) => at(reference).pickupAt.toISOString();

/** 17:00 WIB on a Jakarta civil date, as the UTC instant the courier is sent. */
const at17 = (date: string) => `${date}T10:00:00.000Z`;

const MON = '2026-11-02';
const TUE = '2026-11-03';
const WED = '2026-11-04';
const THU = '2026-11-05';
const FRI = '2026-11-06';
const SAT = '2026-11-07';
const SUN = '2026-11-08';
const NEXT_MON = '2026-11-09';

describe('the approved policy is the default', () => {
  it('cut-off 15:00, pickup 17:00, Asia/Jakarta', () => {
    expect(DEFAULT_PICKUP_POLICY).toEqual({ timeZone: 'Asia/Jakarta', cutoffTime: '15:00', pickupTime: '17:00' });
  });
});

describe('weekday boundaries: 14:59 / 15:00 / 15:01 WIB', () => {
  const NEXT: Record<string, string> = { [MON]: TUE, [TUE]: WED, [WED]: THU, [THU]: FRI };

  describe.each([
    ['Monday', MON],
    ['Tuesday', TUE],
    ['Wednesday', WED],
    ['Thursday', THU],
  ])('%s', (_name, day) => {
    it('14:59 is before the cut-off: picked up the SAME day at 17:00', () => {
      expect(at(`${day}T14:59:00+07:00`)).toEqual({ pickupAt: new Date(at17(day)), reason: 'SAME_DAY' });
    });
    it('15:00 is PAST the cut-off: picked up the NEXT day at 17:00', () => {
      expect(at(`${day}T15:00:00+07:00`)).toEqual({ pickupAt: new Date(at17(NEXT[day])), reason: 'NEXT_DAY' });
    });
    it('15:01 is past the cut-off: the NEXT day at 17:00', () => {
      expect(at(`${day}T15:01:00+07:00`)).toEqual({ pickupAt: new Date(at17(NEXT[day])), reason: 'NEXT_DAY' });
    });
  });

  describe('Friday', () => {
    it('14:59 is before the cut-off: picked up on Friday at 17:00', () => {
      expect(at(`${FRI}T14:59:00+07:00`)).toEqual({ pickupAt: new Date(at17(FRI)), reason: 'SAME_DAY' });
    });
    it.each(['15:00', '15:01', '16:30', '17:00', '20:00', '23:59'])('%s is past the cut-off: Monday at 17:00', (time) => {
      expect(at(`${FRI}T${time}:00+07:00`)).toEqual({
        pickupAt: new Date(at17(NEXT_MON)),
        reason: 'MONDAY_AFTER_FRIDAY_CUTOFF',
      });
    });
  });
});

describe('weekends always resolve to Monday 17:00', () => {
  it.each([
    ['Saturday 00:00', `${SAT}T00:00:00+07:00`],
    ['Saturday 10:00', `${SAT}T10:00:00+07:00`],
    ['Saturday 14:59', `${SAT}T14:59:00+07:00`],
    ['Saturday 15:00', `${SAT}T15:00:00+07:00`],
    ['Saturday 23:59', `${SAT}T23:59:00+07:00`],
    ['Sunday 00:00', `${SUN}T00:00:00+07:00`],
    ['Sunday 12:00', `${SUN}T12:00:00+07:00`],
    ['Sunday 14:59', `${SUN}T14:59:00+07:00`],
    ['Sunday 23:59', `${SUN}T23:59:00+07:00`],
  ])('%s WIB', (_label, reference) => {
    expect(at(reference)).toEqual({ pickupAt: new Date(at17(NEXT_MON)), reason: 'MONDAY_AFTER_WEEKEND' });
  });

  it('Monday 00:00 WIB is an ordinary weekday morning: the same Monday', () => {
    expect(at(`${NEXT_MON}T00:00:00+07:00`)).toEqual({ pickupAt: new Date(at17(NEXT_MON)), reason: 'SAME_DAY' });
  });
});

describe('minute granularity at the cut-off', () => {
  it('15:00:30 belongs to the 15:00 minute, which is past the cut-off', () => {
    expect(pickup(`${TUE}T15:00:30+07:00`)).toBe(at17(WED));
  });
  it('14:59:59 is still before the cut-off', () => {
    expect(pickup(`${TUE}T14:59:59+07:00`)).toBe(at17(TUE));
  });
});

describe('the reference is read in Jakarta, not in UTC', () => {
  it('Friday 23:59 WIB is still Friday 16:59Z: Monday', () => {
    expect(at('2026-11-06T16:59:00Z')).toEqual({
      pickupAt: new Date(at17(NEXT_MON)),
      reason: 'MONDAY_AFTER_FRIDAY_CUTOFF',
    });
  });
  it('Saturday 00:00 WIB is still FRIDAY 17:00Z in UTC: Monday, as a weekend case', () => {
    expect(at('2026-11-06T17:00:00Z')).toEqual({ pickupAt: new Date(at17(NEXT_MON)), reason: 'MONDAY_AFTER_WEEKEND' });
  });
  it('Monday 00:00 WIB is still SUNDAY 17:00Z in UTC: the same Monday, not Tuesday', () => {
    expect(at('2026-11-08T17:00:00Z')).toEqual({ pickupAt: new Date(at17(NEXT_MON)), reason: 'SAME_DAY' });
  });
  it('Thursday 23:30 WIB (16:30Z): Friday', () => {
    expect(pickup('2026-11-05T16:30:00Z')).toBe(at17(FRI));
  });
  it('08:00Z is exactly 15:00 WIB: past the cut-off', () => {
    expect(pickup('2026-11-03T08:00:00Z')).toBe(at17(WED));
    expect(pickup('2026-11-03T07:59:00Z')).toBe(at17(TUE));
  });
});

describe('month and year ends roll on the civil calendar', () => {
  it('Friday 31 Jul 2026 past the cut-off: Monday 3 Aug', () => {
    expect(pickup('2026-07-31T15:00:00+07:00')).toBe(at17('2026-08-03'));
  });
  it('Wednesday 30 Sep 2026 past the cut-off: Thursday 1 Oct', () => {
    expect(pickup('2026-09-30T15:01:00+07:00')).toBe(at17('2026-10-01'));
  });
  it('Thursday 31 Dec 2026 past the cut-off: Friday 1 Jan 2027 (no holiday calendar exists)', () => {
    expect(pickup('2026-12-31T23:00:00+07:00')).toBe(at17('2027-01-01'));
  });
  it('Friday 31 Dec 2027 past the cut-off: Monday 3 Jan 2028', () => {
    expect(pickup('2027-12-31T16:00:00+07:00')).toBe(at17('2028-01-03'));
  });
  it('Monday 28 Feb 2028 past the cut-off: Tuesday 29 Feb (leap day)', () => {
    expect(pickup('2028-02-28T20:00:00+07:00')).toBe(at17('2028-02-29'));
  });
});

describe('every pickup is 17:00 WIB on a weekday, strictly after the verification', () => {
  it('holds for every hour of a full week', () => {
    for (let day = 2; day <= 8; day += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        const reference = `2026-11-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:30:00+07:00`;
        const { pickupAt, reason } = at(reference);
        const wib = new Date(pickupAt.getTime() + 7 * 3_600_000);
        expect(wib.getUTCHours()).toBe(17);
        expect(wib.getUTCMinutes()).toBe(0);
        expect([1, 2, 3, 4, 5]).toContain(wib.getUTCDay());
        expect(pickupAt.getTime()).toBeGreaterThan(new Date(reference).getTime());
        expect(
          ['SAME_DAY', 'NEXT_DAY', 'MONDAY_AFTER_FRIDAY_CUTOFF', 'MONDAY_AFTER_WEEKEND'] as PickupScheduleReason[],
        ).toContain(reason);
      }
    }
  });
});

// ======================= the process timezone, proved in a real other process ==

const BACKEND_ROOT = path.resolve(__dirname, '../..');
const MODULE = path.resolve(__dirname, '../../src/modules/shipping/pickup-schedule.ts');

function resolveUnderTimezone(tz: string, references: string[]): { tz: string; answers: string[] } {
  const snippet = `const { resolvePickupSchedule } = require(${JSON.stringify(MODULE)});
    const policy = ${JSON.stringify(POLICY)};
    const answers = ${JSON.stringify(references)}.map((r) => {
      const s = resolvePickupSchedule(new Date(r), policy);
      return s.pickupAt.toISOString() + ' ' + s.reason;
    });
    console.log(JSON.stringify({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone, answers }));`;
  const stdout = execFileSync(process.execPath, ['-r', 'tsx/cjs', '-e', snippet], {
    env: { ...process.env, TZ: tz },
    cwd: BACKEND_ROOT,
    encoding: 'utf8',
  });
  return JSON.parse(stdout.trim().split('\n').pop() as string) as { tz: string; answers: string[] };
}

describe('identical instants give identical answers under any server timezone', () => {
  const REFERENCES = [
    '2026-11-06T07:59:00Z', // Fri 14:59 WIB -> Friday
    '2026-11-06T08:00:00Z', // Fri 15:00 WIB -> Monday
    '2026-11-06T17:00:00Z', // Sat 00:00 WIB -> Monday
    '2026-11-08T16:59:00Z', // Sun 23:59 WIB -> Monday
    '2026-11-08T17:00:00Z', // Mon 00:00 WIB -> Monday
  ];
  const EXPECTED = [
    `${at17(FRI)} SAME_DAY`,
    `${at17(NEXT_MON)} MONDAY_AFTER_FRIDAY_CUTOFF`,
    `${at17(NEXT_MON)} MONDAY_AFTER_WEEKEND`,
    `${at17(NEXT_MON)} MONDAY_AFTER_WEEKEND`,
    `${at17(NEXT_MON)} SAME_DAY`,
  ];

  it('TZ=UTC (the container) and TZ=Asia/Jakarta (a developer host) agree', () => {
    const utc = resolveUnderTimezone('UTC', REFERENCES);
    const jakarta = resolveUnderTimezone('Asia/Jakarta', REFERENCES);
    expect(utc.tz).toBe('UTC');
    expect(jakarta.tz).toBe('Asia/Jakarta');
    expect(utc.answers).toEqual(EXPECTED);
    expect(jakarta.answers).toEqual(EXPECTED);
  }, 120_000);

  it('a process on the other side of the date line agrees too', () => {
    expect(resolveUnderTimezone('Pacific/Kiritimati', REFERENCES).answers).toEqual(EXPECTED);
  }, 120_000);
});
