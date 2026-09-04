/**
 * PAXELBOX-61AG.3.7 — the coordinate-pair guard on address UPDATE.
 *
 * Regression cover for a hole confirmed three times: against the service in
 * 61AG.3.3, against a real MySQL row in 61AG.3.4, and through a real browser in
 * 61AG.3.5. `PATCH {latitude: 0, longitude: 0}` touches no LOCATION_FIELD, so it
 * short-circuits geocoding and was written verbatim over a correct pin.
 *
 * The two properties that must hold TOGETHER, and which pull in opposite
 * directions, are asserted here side by side:
 *   1. a coordinate-only patch must NEVER call Google (that is why
 *      latitude/longitude are excluded from LOCATION_FIELDS), and
 *   2. a coordinate-only patch must never persist an unusable pin.
 *
 * Every test runs the real ValidationPipe over the real DTO — the guard lives in
 * validation, so validating anything less would not prove it.
 */

import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { CreateAddressDto, UpdateAddressDto } from '../../src/modules/users/application/dto/address.dto';
import {
  AddressGeocodingService,
  touchesLocation,
} from '../../src/modules/geocoding/address-geocoding.service';

// The pipe as main.ts configures it; anything weaker would not be the real gate.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

const asUpdate = (body: Record<string, unknown>) =>
  pipe.transform(body, { type: 'body', metatype: UpdateAddressDto });
const asCreate = (body: Record<string, unknown>) =>
  pipe.transform(body, { type: 'body', metatype: CreateAddressDto });

/** Message text of the rejection, for asserting WHICH rule fired. */
async function rejectionOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    const res = (e as BadRequestException).getResponse() as { message?: string[] | string };
    return JSON.stringify(res.message ?? '');
  }
  return '';
}

const VALID = { latitude: -6.9207623, longitude: 107.6096701 };

describe('UpdateAddressDto coordinate pair', () => {
  describe('accepts', () => {
    it('a valid latitude/longitude-only patch — dragging a pin stays allowed', async () => {
      await expect(asUpdate({ ...VALID })).resolves.toMatchObject(VALID);
    });

    it('a patch with no coordinates at all', async () => {
      await expect(asUpdate({ label: 'Kantor' })).resolves.toEqual({ label: 'Kantor' });
    });

    it('an empty patch', async () => {
      await expect(asUpdate({})).resolves.toEqual({});
    });

    it('a coordinate on exactly one axis at zero — a real point, not the placeholder', async () => {
      await expect(asUpdate({ latitude: 0, longitude: 107.6 })).resolves.toMatchObject({ latitude: 0 });
      await expect(asUpdate({ latitude: -6.9, longitude: 0 })).resolves.toMatchObject({ longitude: 0 });
    });

    it('coordinates alongside other fields', async () => {
      await expect(asUpdate({ ...VALID, label: 'Rumah', isDefault: true })).resolves.toMatchObject(VALID);
    });
  });

  describe('rejects', () => {
    it('THE BUG: latitude 0 / longitude 0', async () => {
      await expect(asUpdate({ latitude: 0, longitude: 0 })).rejects.toBeInstanceOf(BadRequestException);
      expect(await rejectionOf(() => asUpdate({ latitude: 0, longitude: 0 }))).toMatch(/coordinate pair/i);
    });

    it('0,0 even when the patch also carries innocent fields', async () => {
      await expect(asUpdate({ latitude: 0, longitude: 0, label: 'Rumah' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it.each([
      ['latitude below -90', { latitude: -91, longitude: 107 }],
      ['latitude above 90', { latitude: 91, longitude: 107 }],
      ['longitude below -180', { latitude: -6.9, longitude: -181 }],
      ['longitude above 180', { latitude: -6.9, longitude: 181 }],
    ])('%s', async (_label, body) => {
      await expect(asUpdate(body)).rejects.toBeInstanceOf(BadRequestException);
    });

    describe('half a pair — one axis alone leaves the pin somewhere neither old nor new', () => {
      it('latitude without longitude', async () => {
        await expect(asUpdate({ latitude: -6.9207623 })).rejects.toBeInstanceOf(BadRequestException);
      });

      it('longitude without latitude', async () => {
        await expect(asUpdate({ longitude: 107.6096701 })).rejects.toBeInstanceOf(BadRequestException);
      });

      it('names the missing axis rather than failing silently', async () => {
        expect(await rejectionOf(() => asUpdate({ longitude: 107.6096701 }))).toMatch(/latitude/i);
      });
    });
  });

  describe('the create flow is deliberately unchanged', () => {
    const createBody = {
      label: 'Rumah',
      recipientName: 'Smoke Test',
      phone: '081200000000',
      fullAddress: 'Jl. Braga No. 1, Sumur Bandung',
      isDefault: false,
      latitude: 0,
      longitude: 0,
    };

    it('still accepts 0,0 on create — the server geocodes over it', async () => {
      // Tightening this would break the address form, which has no map picker and
      // sends 0,0 by design. The placeholder is replaced by AddressGeocodingService,
      // not rejected (PAXELBOX-61AG.3).
      await expect(asCreate({ ...createBody })).resolves.toMatchObject({ latitude: 0, longitude: 0 });
    });
  });
});

describe('the guard does not disturb geocoding behaviour', () => {
  function build(geocode: () => Promise<{ latitude: number; longitude: number }>) {
    const calls: string[] = [];
    const prisma = {
      province: { findUnique: async () => ({ name: 'Jawa Barat' }) },
      city: { findUnique: async () => ({ name: 'Kota Bandung' }) },
      district: { findUnique: async () => ({ name: 'Sumur Bandung' }) },
      village: { findUnique: async () => ({ name: 'Braga' }) },
    };
    const geocoding = {
      enabled: true,
      geocode: async (q: string) => {
        calls.push(q);
        return geocode();
      },
    };
    return { service: new AddressGeocodingService(prisma as never, geocoding as never), calls };
  }
  const coords = async () => ({ latitude: -6.9207623, longitude: 107.6096701 });

  it('latitude/longitude still do NOT count as a location move', () => {
    // The whole reason the fix lives in validation: widening this would make every
    // pin edit spend a Google request.
    expect(touchesLocation({ latitude: -6.9, longitude: 107.6 })).toBe(false);
  });

  it('a valid coordinate-only patch costs ZERO Google calls', async () => {
    const { service, calls } = build(coords);
    const out = await service.withCoordinates({ ...VALID }, { skipWhenUnchanged: true });
    expect(calls).toHaveLength(0);
    expect(out).toEqual(VALID);
  });

  it('a location-field patch still triggers geocoding', async () => {
    const { service, calls } = build(coords);
    const out = await service.withCoordinates(
      { cityId: 'c1', addressDetail: 'Jl. Baru' } as Record<string, unknown>,
      { skipWhenUnchanged: true },
    );
    expect(calls).toHaveLength(1);
    expect(out.latitude).toBe(-6.9207623);
  });

  it('create with 0,0 still geocodes and overwrites the placeholder', async () => {
    const { service, calls } = build(coords);
    const out = await service.withCoordinates({
      addressDetail: 'Jl. Braga No. 1',
      provinceId: 'p1',
      cityId: 'c1',
      districtId: 'd1',
      villageId: 'v1',
      postalCode: '40111',
      latitude: 0,
      longitude: 0,
    });
    expect(calls).toHaveLength(1);
    expect(out.latitude).toBe(-6.9207623);
    expect(out.longitude).toBe(107.6096701);
  });
});
