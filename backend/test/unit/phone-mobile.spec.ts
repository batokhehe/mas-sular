/**
 * PAXELBOX-61AG.3.20 — Indonesian mobile contract for the address phone.
 *
 * The rule that matters: Address.phone is what a courier calls and what Mekari
 * Qontak messages on WhatsApp, so it must be a MOBILE number stored canonically
 * as `628…`. Landlines and malformed values are refused, not stored and repaired
 * later — 61AG.3.19 found `abcdefghij` sitting in the column.
 *
 * All numbers below are synthetic (0812-0000-xxxx is not an allocated range).
 */

import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  InvalidPhoneError,
  isIndonesianMobile,
  maskPhone,
  normalizeIndonesianMobile,
  normalizePhoneNumber,
} from '../../src/common/utils/phone.util';
import { CreateAddressDto, UpdateAddressDto } from '../../src/modules/users/application/dto/address.dto';

const CANONICAL = '6281200000000';

describe('normalizeIndonesianMobile', () => {
  it.each([
    ['national 08 form', '081200000000'],
    ['country code', '6281200000000'],
    ['E.164', '+6281200000000'],
    ['bare subscriber', '81200000000'],
    ['hyphenated', '0812-0000-0000'],
    ['spaced', '0812 0000 0000'],
    ['spaced country code', '+62 812 0000 0000'],
    ['parenthesised', '(0812) 0000-0000'],
  ])('accepts %s and returns canonical 628…', (_label, input) => {
    expect(normalizeIndonesianMobile(input)).toBe(CANONICAL);
  });

  it('is idempotent — a canonical value normalises to itself', () => {
    expect(normalizeIndonesianMobile(CANONICAL)).toBe(CANONICAL);
  });

  describe('rejects', () => {
    it.each([
      ['a Jakarta landline', '0211234567'],
      ['a Bandung landline', '0221234567'],
      ['a landline in +62 form', '+62211234567'],
    ])('%s — mobile-only is the point of this function', (_label, input) => {
      expect(() => normalizeIndonesianMobile(input)).toThrow(InvalidPhoneError);
      // The general normalizer still accepts these; only the mobile rule differs.
      expect(() => normalizePhoneNumber(input)).not.toThrow();
    });

    it.each([
      ['alphabetic', 'abcdefghij'],
      ['mixed alphanumeric', 'ab12!@#$%^&*'],
      ['malformed +62', '+62abc1234567'],
      ['bare country code', '62'],
      ['too short', '0812'],
      ['too long', '0812000000000000000'],
      ['empty', ''],
      ['whitespace', '   '],
      ['punctuation only', '--- --- ---'],
      ['a US number', '+14155550100'],
      ['a Singapore number', '+6591230000'],
    ])('%s', (_label, input) => {
      expect(() => normalizeIndonesianMobile(input)).toThrow(InvalidPhoneError);
    });

    it('null and undefined', () => {
      expect(() => normalizeIndonesianMobile(null)).toThrow(InvalidPhoneError);
      expect(() => normalizeIndonesianMobile(undefined)).toThrow(InvalidPhoneError);
    });
  });

  it('never echoes the rejected value — it is customer data', () => {
    try {
      normalizeIndonesianMobile('0211234567');
      fail('expected a throw');
    } catch (e) {
      expect((e as Error).message).not.toContain('0211234567');
    }
  });
});

describe('isIndonesianMobile', () => {
  it('never throws, whatever it is given', () => {
    expect(isIndonesianMobile('081200000000')).toBe(true);
    expect(isIndonesianMobile('0211234567')).toBe(false);
    expect(isIndonesianMobile(undefined)).toBe(false);
    expect(isIndonesianMobile(42 as unknown as string)).toBe(false);
    expect(isIndonesianMobile({} as unknown as string)).toBe(false);
  });
});

describe('existing consumers are unaffected', () => {
  it('normalizePhoneNumber keeps its original, broader contract', () => {
    // The notification stack depends on this. Narrowing it here would change
    // behaviour far outside the address flow.
    expect(normalizePhoneNumber('0211234567')).toBe('62211234567');
    expect(normalizePhoneNumber('081200000000')).toBe(CANONICAL);
  });

  it('maskPhone still hides all but the last four digits', () => {
    expect(maskPhone(CANONICAL)).toBe('628****0000');
  });
});

// ------------------------------------------------------------------ DTO ----

const createBody = (phone: unknown) => ({
  label: 'Rumah', recipientName: 'Test User', phone,
  fullAddress: 'Jl. Braga No. 1, Sumur Bandung', isDefault: false,
  latitude: 0, longitude: 0,
});

const phoneErrors = (dto: object) =>
  validateSync(dto as object).filter((e) => e.property === 'phone');

describe('CreateAddressDto phone', () => {
  it.each(['081200000000', '+6281200000000', '6281200000000', '0812-0000-0000'])(
    'accepts %s and CANONICALISES it before validation',
    (input) => {
      const dto = plainToInstance(CreateAddressDto, createBody(input));
      expect(phoneErrors(dto)).toHaveLength(0);
      expect(dto.phone).toBe(CANONICAL);
    },
  );

  it.each([
    ['landline', '0211234567'],
    ['alphabetic', 'abcdefghij'],
    ['mixed', 'ab12!@#$%^&*'],
    ['malformed +62', '+62abc1234567'],
    ['too short', '0812'],
    ['too long', '0812000000000000000'],
    ['empty', ''],
    ['foreign', '+14155550100'],
  ])('rejects %s', (_label, input) => {
    const dto = plainToInstance(CreateAddressDto, createBody(input));
    expect(phoneErrors(dto).length).toBeGreaterThan(0);
  });

  it('leaves an unnormalisable value untouched rather than blanking it', () => {
    // Hiding a bad number would be worse than refusing it.
    const dto = plainToInstance(CreateAddressDto, createBody('abcdefghij'));
    expect(dto.phone).toBe('abcdefghij');
  });
});

describe('UpdateAddressDto phone', () => {
  it('canonicalises a supplied value', () => {
    const dto = plainToInstance(UpdateAddressDto, { phone: '+6281200000000' });
    expect(phoneErrors(dto)).toHaveLength(0);
    expect(dto.phone).toBe(CANONICAL);
  });

  it('rejects a landline on PATCH too — create and update share one contract', () => {
    const dto = plainToInstance(UpdateAddressDto, { phone: '0211234567' });
    expect(phoneErrors(dto).length).toBeGreaterThan(0);
  });

  it('stays optional: omitting phone leaves the stored number alone', () => {
    const dto = plainToInstance(UpdateAddressDto, { label: 'Kantor' });
    expect(phoneErrors(dto)).toHaveLength(0);
    expect(dto.phone).toBeUndefined();
  });
});
