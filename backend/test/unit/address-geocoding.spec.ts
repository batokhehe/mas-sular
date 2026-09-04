/**
 * PAXELBOX-61AG.3 — address → coordinates, and the Paxel guard that stops a
 * placeholder reaching the courier.
 */

import {
  AddressGeocodingService,
  buildGeocodeQuery,
  touchesLocation,
} from '../../src/modules/geocoding/address-geocoding.service';
import { GeocodingFailedError } from '../../src/modules/geocoding/geocoding.errors';
import { PaxelProvider } from '../../src/modules/shipping/infrastructure/providers/paxel.provider';
import type { ShippingConfig } from '../../src/modules/shipping/shipping.config';
import type { ShippingRateRequest } from '../../src/modules/shipping/domain/shipping-provider.interface';

// --------------------------------------------------------------- query ----

describe('buildGeocodeQuery', () => {
  it('orders parts from most specific outward and anchors on Indonesia', () => {
    expect(
      buildGeocodeQuery({
        street: 'Jl. Braga No. 1',
        village: 'Braga',
        district: 'Sumur Bandung',
        city: 'Kota Bandung',
        province: 'Jawa Barat',
        postalCode: '40111',
      }),
    ).toBe('Jl. Braga No. 1, Braga, Sumur Bandung, Kota Bandung, Jawa Barat, 40111, Indonesia');
  });

  it('drops missing parts instead of emitting blanks', () => {
    expect(buildGeocodeQuery({ street: 'Jl. Braga', city: 'Kota Bandung' })).toBe('Jl. Braga, Kota Bandung, Indonesia');
    expect(buildGeocodeQuery({ street: 'Jl. Braga', village: null, district: '   ', city: 'Kota Bandung' })).not.toContain(', ,');
  });

  it('still anchors on Indonesia when everything else is missing', () => {
    expect(buildGeocodeQuery({})).toBe('Indonesia');
  });
});

// ------------------------------------------------------ change detection ----

describe('touchesLocation', () => {
  it.each(['fullAddress', 'addressDetail', 'postalCode', 'provinceId', 'cityId', 'districtId', 'villageId'])(
    '%s moves the address',
    (field) => {
      expect(touchesLocation({ [field]: 'x' })).toBe(true);
    },
  );

  it.each(['label', 'recipientName', 'phone', 'notes', 'isDefault', 'latitude', 'longitude'])(
    '%s does NOT move the address',
    (field) => {
      expect(touchesLocation({ [field]: 'x' })).toBe(false);
    },
  );

  it('ignores keys explicitly set to undefined, as a PATCH leaves them', () => {
    expect(touchesLocation({ cityId: undefined, label: 'Home' })).toBe(false);
  });
});

// ------------------------------------------------------------- service ----

function build(enabled: boolean, geocode: () => Promise<{ latitude: number; longitude: number }>) {
  const calls: string[] = [];
  const prisma = {
    province: { findUnique: async () => ({ name: 'Jawa Barat' }) },
    city: { findUnique: async () => ({ name: 'Kota Bandung' }) },
    district: { findUnique: async () => ({ name: 'Andir' }) },
    village: { findUnique: async () => ({ name: 'Campaka' }) },
  };
  const geocoding = {
    enabled,
    geocode: async (q: string) => {
      calls.push(q);
      return geocode();
    },
  };
  return { service: new AddressGeocodingService(prisma as never, geocoding as never), calls };
}

const coords = async () => ({ latitude: -6.9034, longitude: 107.5731 });
const dto = {
  label: 'Home',
  addressDetail: 'Jl. Garuda No. 5',
  provinceId: 'p1',
  cityId: 'c1',
  districtId: 'd1',
  villageId: 'v1',
  postalCode: '40184',
  latitude: 0,
  longitude: 0,
};

describe('AddressGeocodingService', () => {
  it('geocodes on create and replaces the client-supplied placeholder', async () => {
    const { service, calls } = build(true, coords);
    const out = await service.withCoordinates({ ...dto });
    expect(out.latitude).toBe(-6.9034);
    expect(out.longitude).toBe(107.5731);
    expect(calls[0]).toBe('Jl. Garuda No. 5, Campaka, Andir, Kota Bandung, Jawa Barat, 40184, Indonesia');
  });

  it('resolves region IDs to NAMES — Google cannot read Kemendagri ids', async () => {
    const { service, calls } = build(true, coords);
    await service.withCoordinates({ ...dto });
    expect(calls[0]).not.toContain('p1');
    expect(calls[0]).not.toContain('d1');
    expect(calls[0]).toContain('Kota Bandung');
  });

  it('does nothing at all when the feature is disabled', async () => {
    const { service, calls } = build(false, coords);
    const out = await service.withCoordinates({ ...dto });
    expect(out).toEqual(dto);
    expect(calls).toHaveLength(0);
  });

  it('PROPAGATES a geocoding failure — no fake coordinate is ever returned', async () => {
    const { service } = build(true, async () => {
      throw new GeocodingFailedError('Geocoding returned ZERO_RESULTS', 'ZERO_RESULTS');
    });
    await expect(service.withCoordinates({ ...dto })).rejects.toBeInstanceOf(GeocodingFailedError);
  });

  describe('update', () => {
    it('re-geocodes when a location field changed', async () => {
      const { service, calls } = build(true, coords);
      const out = await service.withCoordinates(
        { cityId: 'c1', addressDetail: 'Jl. Baru' } as Record<string, unknown>,
        { skipWhenUnchanged: true },
      );
      expect(calls).toHaveLength(1);
      expect(out.latitude).toBe(-6.9034);
    });

    it('does NOT geocode when only non-location fields changed', async () => {
      const { service, calls } = build(true, coords);
      const patch = { label: 'Office', recipientName: 'Budi', phone: '08123456789' };
      const out = await service.withCoordinates({ ...patch }, { skipWhenUnchanged: true });
      expect(calls).toHaveLength(0);
      expect(out).toEqual(patch);
    });

    it('leaves an existing pin untouched on a non-location edit', async () => {
      const { service } = build(true, coords);
      const out = await service.withCoordinates({ phone: '08123456789' }, { skipWhenUnchanged: true });
      expect(out).not.toHaveProperty('latitude');
    });
  });
});

// --------------------------------------------------------------- paxel ----

describe('PaxelProvider omits unusable coordinates', () => {
  const config = (): ShippingConfig =>
    ({
      originPostalCode: '40111',
      allowMockRates: false,
      paxel: {
        enabled: true, baseUrl: 'https://paxel.test', apiKey: 'k', apiSecret: 's',
        originPhone: '081212121212', originNote: 'gerbang samping', needInsurance: false,
        timeoutMs: 500, maxRetry: 0, defaultDimension: '30x35x20',
      },
      jne: { enabled: false, baseUrl: 'https://jne.test', timeoutMs: 500, maxRetry: 0 },
      rajaongkir: { enabled: false, baseUrl: 'https://ro.test', timeoutMs: 500, maxRetry: 1 },
    }) as ShippingConfig;

  const request = (over: Partial<ShippingRateRequest> = {}): ShippingRateRequest => ({
    originPostalCode: '40111',
    destinationPostalCode: '40181',
    weightGram: 1000,
    originAddress: 'Jl. Outlet', originProvince: 'Jawa Barat', originCity: 'Kota Bandung', originDistrict: 'Buahbatu',
    destinationAddress: 'Jl. Tujuan', destinationProvince: 'Jawa Barat', destinationCity: 'Kota Bandung', destinationDistrict: 'Andir',
    originLatitude: -6.9532467, originLongitude: 107.6630995,
    ...over,
  });

  /** Reads the destination object out of the request body Paxel would receive. */
  async function destinationSentFor(over: Partial<ShippingRateRequest>) {
    const http = jest.fn().mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify({ data: { fixed_price: 15000, fixed_size: 'S' } }),
      headers: { get: () => null },
    });
    const provider = new PaxelProvider(config());
    (provider as unknown as { http: unknown }).http = http;
    await provider.getRates(request(over));
    return JSON.parse(String(http.mock.calls[0][1].body)).destination as Record<string, unknown>;
  }

  it('includes a real coordinate', async () => {
    const d = await destinationSentFor({ destinationLatitude: -6.9034, destinationLongitude: 107.5731 });
    expect(d.latitude).toBe(-6.9034);
    expect(d.longitude).toBe(107.5731);
  });

  it('OMITS 0,0 — the address-form placeholder must never reach Paxel', async () => {
    const d = await destinationSentFor({ destinationLatitude: 0, destinationLongitude: 0 });
    expect(d).not.toHaveProperty('latitude');
    expect(d).not.toHaveProperty('longitude');
    // The named fields still go, so Paxel can price from the address itself.
    expect(d.city).toBe('Kota Bandung');
    expect(d.district).toBe('Andir');
  });

  it('omits undefined coordinates, as before', async () => {
    const d = await destinationSentFor({ destinationLatitude: undefined, destinationLongitude: undefined });
    expect(d).not.toHaveProperty('latitude');
  });

  it('omits an out-of-range coordinate', async () => {
    const d = await destinationSentFor({ destinationLatitude: 91, destinationLongitude: 107 });
    expect(d).not.toHaveProperty('latitude');
  });

  it('omits a half-supplied pair rather than sending one axis', async () => {
    const d = await destinationSentFor({ destinationLatitude: -6.9034, destinationLongitude: undefined });
    expect(d).not.toHaveProperty('latitude');
    expect(d).not.toHaveProperty('longitude');
  });
});
