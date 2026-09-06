/**
 * Admin promo datetime handling.
 *
 * THE BUG: PATCH /admin/catalog/promos/:id sent the browser's naked wall clock
 * ("2026-09-12T09:59") straight to Prisma, which requires full ISO-8601 and
 * answered "premature end of input".
 *
 * THE QUIETER BUG: createPromo did convert, with `new Date(dto.startDate)` —
 * which reads the NODE PROCESS TIMEZONE for a value with no offset. That is
 * Asia/Jakarta on a developer machine and UTC in the container, so the same
 * admin action stored two instants seven hours apart depending on where it ran.
 *
 * Every expectation below is an absolute UTC instant, deliberately: asserting on
 * a local rendering would let a broken implementation agree with the test on a
 * machine that happens to run in Jakarta.
 */
import { ValidationPipe } from '@nestjs/common';
import { BUSINESS_TIMEZONE, formatBusinessDateTimeLocal, parseBusinessDateTime } from '../../src/common/utils/business-time.util';
import { CreatePromoDto } from '../../src/modules/admin/application/dto/create-promo.dto';
import { UpdatePromoDto } from '../../src/modules/admin/application/dto/update-promo.dto';
import { AdminService } from '../../src/modules/admin/admin.service';

const iso = (value: string) => parseBusinessDateTime(value)?.toISOString();

// ============================================================ the parser =====

describe('parseBusinessDateTime', () => {
  it('states the business timezone once, and it is Asia/Jakarta', () => {
    expect(BUSINESS_TIMEZONE).toBe('Asia/Jakarta');
  });

  it('reads the reported values as Jakarta wall clock, not UTC', () => {
    // 09:59 WIB is 02:59Z. The whole point: NOT "2026-09-12T09:59:00Z".
    expect(iso('2026-09-12T09:59')).toBe('2026-09-12T02:59:00.000Z');
    expect(iso('2027-03-26T09:59')).toBe('2027-03-26T02:59:00.000Z');
  });

  it.each([
    ['2026-09-12T00:00', '2026-09-11T17:00:00.000Z'], // midnight WIB is 17:00Z the day before
    ['2026-09-12T23:59', '2026-09-12T16:59:00.000Z'],
    ['2026-09-12T12:00', '2026-09-12T05:00:00.000Z'],
  ])('handles the day boundary %s', (input, expected) => {
    expect(iso(input)).toBe(expected);
  });

  it('accepts optional seconds and milliseconds', () => {
    expect(iso('2026-09-12T09:59:30')).toBe('2026-09-12T02:59:30.000Z');
    expect(iso('2026-09-12T09:59:30.250')).toBe('2026-09-12T02:59:30.250Z');
  });

  it('respects a value that already carries its own offset', () => {
    // An API client that states an offset means it — never reinterpreted.
    expect(iso('2026-09-12T09:59:00+07:00')).toBe('2026-09-12T02:59:00.000Z');
    expect(iso('2026-09-12T02:59:00.000Z')).toBe('2026-09-12T02:59:00.000Z');
    expect(iso('2026-09-12T09:59:00Z')).toBe('2026-09-12T09:59:00.000Z');
    // A different zone stays that instant, it is not shifted into Jakarta.
    expect(iso('2026-09-12T09:59:00+00:00')).toBe('2026-09-12T09:59:00.000Z');
  });

  it.each([
    ['2026-09-12'],          // a bare date is not a moment
    ['2026-99-99T09:59'],    // month/day out of range
    ['2026-09-12T25:99'],    // hour/minute out of range
    ['2026-02-30T09:59'],    // shape is fine, the date does not exist
    ['2026-13-01T09:59'],
    ['garbage'],
    ['09:59'],
    [''],
    ['   '],
    ['2026-09-12T09'],       // premature end of input — the original symptom
  ])('refuses %p', (input) => {
    expect(parseBusinessDateTime(input)).toBeNull();
  });

  it('never rolls an impossible date into a neighbouring one', () => {
    // Date.UTC would happily turn 30 February into 1/2 March. It must not.
    expect(parseBusinessDateTime('2026-02-30T09:59')).toBeNull();
    expect(parseBusinessDateTime('2026-04-31T09:59')).toBeNull();
    // ...while a real leap day is accepted.
    expect(iso('2028-02-29T09:59')).toBe('2028-02-29T02:59:00.000Z');
  });

  it('round-trips through the datetime-local formatter', () => {
    const instant = parseBusinessDateTime('2026-09-12T09:59') as Date;
    expect(formatBusinessDateTimeLocal(instant)).toBe('2026-09-12T09:59');
    // And an instant stored as UTC renders as the Jakarta wall clock.
    expect(formatBusinessDateTimeLocal(new Date('2026-09-11T17:00:00.000Z'))).toBe('2026-09-12T00:00');
  });
});

// =============================================== the DTO boundary, for real ==

/**
 * Through the REAL global ValidationPipe, configured exactly as main.ts does —
 * `transform: true` with `enableImplicitConversion: true`. That combination is
 * the trap: class-transformer applies implicit conversion BEFORE custom
 * transforms, so a `Date`-typed property would first be run through
 * `new Date(value)` (process timezone) unless the decorator reads the raw body.
 */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

const BASE_CREATE = {
  code: 'HEMAT10',
  title: 'Hemat 10%',
  description: 'Diskon sepuluh persen',
  voucherType: 'PERCENTAGE_DISCOUNT',
  discountPercentage: 10,
};

const throughCreate = (body: Record<string, unknown>) =>
  pipe.transform({ ...BASE_CREATE, ...body }, { type: 'body', metatype: CreatePromoDto }) as Promise<CreatePromoDto>;
const throughUpdate = (body: Record<string, unknown>) =>
  pipe.transform(body, { type: 'body', metatype: UpdatePromoDto }) as Promise<UpdatePromoDto>;

describe('the DTO boundary turns browser values into instants', () => {
  it('CREATE: the reported values become Dates at the right instant', async () => {
    const dto = await throughCreate({ startDate: '2026-09-12T09:59', endDate: '2027-03-26T09:59' });

    expect(dto.startDate).toBeInstanceOf(Date);
    expect(dto.endDate).toBeInstanceOf(Date);
    expect(dto.startDate!.toISOString()).toBe('2026-09-12T02:59:00.000Z');
    expect(dto.endDate!.toISOString()).toBe('2027-03-26T02:59:00.000Z');
  });

  it('UPDATE: the reported values become Dates at the right instant', async () => {
    const dto = await throughUpdate({ startDate: '2026-09-12T09:59', endDate: '2027-03-26T09:59' });

    expect(dto.startDate).toBeInstanceOf(Date);
    expect(dto.startDate!.toISOString()).toBe('2026-09-12T02:59:00.000Z');
    expect(dto.endDate!.toISOString()).toBe('2027-03-26T02:59:00.000Z');
  });

  it('is NOT defeated by enableImplicitConversion reading the process timezone', async () => {
    // If the decorator transformed `value` instead of the raw body, this would
    // be `new Date("2026-09-12T09:59")` — 02:59Z only on a Jakarta machine, and
    // 09:59Z in the container. The assertion is absolute, so it pins the fix on
    // any machine.
    const dto = await throughUpdate({ startDate: '2026-09-12T09:59' });
    expect(dto.startDate!.toISOString()).toBe('2026-09-12T02:59:00.000Z');
    expect(dto.startDate!.toISOString()).not.toBe('2026-09-12T09:59:00.000Z');
  });

  /**
   * plainToInstance emits EVERY declared property, so an unsent field is present
   * with the value `undefined` rather than absent. That is exactly what Prisma
   * needs: it treats `undefined` as "leave this column alone" and `null` as "set
   * it to NULL". The distinction is what keeps a sparse PATCH from wiping the
   * promo window, so it is asserted on the value, not on key presence.
   */
  it('a sparse PATCH leaves the unsent date undefined', async () => {
    const onlyStart = await throughUpdate({ startDate: '2026-09-12T09:59' });
    expect(onlyStart.startDate).toBeInstanceOf(Date);
    expect(onlyStart.endDate).toBeUndefined();
    expect(onlyStart.endDate).not.toBeNull();

    const onlyEnd = await throughUpdate({ endDate: '2027-03-26T09:59' });
    expect(onlyEnd.endDate).toBeInstanceOf(Date);
    expect(onlyEnd.startDate).toBeUndefined();

    const neither = await throughUpdate({ title: 'Judul baru' });
    expect(neither.startDate).toBeUndefined();
    expect(neither.endDate).toBeUndefined();
  });

  it('still accepts a full ISO instant, unchanged', async () => {
    const dto = await throughUpdate({ startDate: '2026-09-12T02:59:00.000Z' });
    expect(dto.startDate!.toISOString()).toBe('2026-09-12T02:59:00.000Z');
  });

  it.each([
    ['2026-09-12'],
    ['2026-99-99T09:59'],
    ['2026-09-12T25:99'],
    ['garbage'],
    ['2026-09-12T09'],
  ])('rejects %p with a 400 instead of letting it reach Prisma', async (bad) => {
    await expect(throughUpdate({ startDate: bad })).rejects.toMatchObject({ status: 400 });
    await expect(throughCreate({ startDate: bad })).rejects.toMatchObject({ status: 400 });
  });

  it('names the field and explains the accepted shape in the 400', async () => {
    // The detail lives in the exception RESPONSE, not in `.message` (which is
    // just "Bad Request Exception").
    const messages = async (body: Record<string, unknown>) => {
      try {
        await throughUpdate(body);
        throw new Error('expected a validation failure');
      } catch (err) {
        const response = (err as { getResponse?: () => unknown }).getResponse?.();
        return JSON.stringify(response);
      }
    };

    expect(await messages({ startDate: 'garbage' })).toMatch(/startDate/);
    expect(await messages({ endDate: 'garbage' })).toMatch(/Asia\/Jakarta/);
    expect(await messages({ endDate: 'garbage' })).toMatch(/2026-09-12T09:59/);
  });
});

// ================================================ service -> Prisma contract ==

describe('AdminService hands Prisma real Dates', () => {
  function build() {
    const promo = { id: 'p1', deletedAt: null };
    const prisma = {
      promo: {
        create: jest.fn().mockResolvedValue(promo),
        update: jest.fn().mockResolvedValue(promo),
        findUnique: jest.fn().mockResolvedValue(promo),
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { service: new AdminService(prisma as any, {} as any), prisma };
  }

  it('createPromo passes Dates, never strings', async () => {
    const { service, prisma } = build();
    const dto = await throughCreate({ startDate: '2026-09-12T09:59', endDate: '2027-03-26T09:59' });

    await service.createPromo(dto);

    const data = prisma.promo.create.mock.calls[0][0].data;
    expect(data.startDate).toBeInstanceOf(Date);
    expect(data.endDate).toBeInstanceOf(Date);
    expect(data.startDate.toISOString()).toBe('2026-09-12T02:59:00.000Z');
    expect(data.endDate.toISOString()).toBe('2027-03-26T02:59:00.000Z');
  });

  it('createPromo still writes null when no window was given', async () => {
    const { service, prisma } = build();
    await service.createPromo(await throughCreate({}));

    const data = prisma.promo.create.mock.calls[0][0].data;
    expect(data.startDate).toBeNull();
    expect(data.endDate).toBeNull();
  });

  it('updatePromo passes Dates, never strings — the reported failure', async () => {
    const { service, prisma } = build();
    const dto = await throughUpdate({ startDate: '2026-09-12T09:59', endDate: '2027-03-26T09:59' });

    await service.updatePromo('p1', dto);

    const data = prisma.promo.update.mock.calls[0][0].data;
    expect(typeof data.startDate).not.toBe('string');
    expect(data.startDate).toBeInstanceOf(Date);
    expect(data.startDate.toISOString()).toBe('2026-09-12T02:59:00.000Z');
    expect(data.endDate.toISOString()).toBe('2027-03-26T02:59:00.000Z');
  });

  it('updatePromo without dates leaves the stored window untouched', async () => {
    const { service, prisma } = build();
    await service.updatePromo('p1', await throughUpdate({ title: 'Judul baru' }));

    const data = prisma.promo.update.mock.calls[0][0].data;
    // undefined, NOT null: Prisma skips undefined and would write NULL for null.
    // This is what stops an unrelated edit from wiping the promo window.
    expect(data.startDate).toBeUndefined();
    expect(data.endDate).toBeUndefined();
    expect(data.startDate).not.toBeNull();
    expect(data.title).toBe('Judul baru');
  });

  it.each([
    ['startDate', { startDate: '2026-09-12T09:59' }, '2026-09-12T02:59:00.000Z'],
    ['endDate', { endDate: '2027-03-26T09:59' }, '2027-03-26T02:59:00.000Z'],
  ])('updatePromo can change only %s', async (field, body, expected) => {
    const { service, prisma } = build();
    await service.updatePromo('p1', await throughUpdate(body));

    const data = prisma.promo.update.mock.calls[0][0].data;
    expect(data[field].toISOString()).toBe(expected);
    // Every other column is undefined, so Prisma writes exactly one of them.
    const written = Object.entries(data).filter(([, v]) => v !== undefined);
    expect(written.map(([k]) => k)).toEqual([field]);
  });
});
