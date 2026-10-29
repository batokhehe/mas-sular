/**
 * Checkout behaviour around JNE destination mappings, and the admin diagnostics that
 * explain it. Offline: JNE's HTTP transport is a double and Prisma is a fake.
 */
import { Logger } from '@nestjs/common';
import { JneDestinationDiagnostics } from '../../src/modules/shipping/infrastructure/jne-destination.diagnostics';
import { JneDestinationResolver } from '../../src/modules/shipping/infrastructure/jne-destination.resolver';
import { JneProvider } from '../../src/modules/shipping/infrastructure/providers/jne.provider';
import type { ShippingProvider, ShippingQuote, ShippingRateRequest } from '../../src/modules/shipping/domain/shipping-provider.interface';
import type { ShippingConfig } from '../../src/modules/shipping/shipping.config';
import { ShippingProviderFactory } from '../../src/modules/shipping/shipping-provider.factory';
import { ShippingService } from '../../src/modules/shipping/shipping.service';

const config = {
  allowMockRates: true,
  paxel: { enabled: false, baseUrl: 'https://paxel.test', timeoutMs: 500, maxRetry: 0, defaultDimension: '30x35x20', needInsurance: false },
  jne: { enabled: true, environment: 'sandbox', baseUrl: 'https://apiv2.jne.co.id:10202', apiKey: 'jne-secret', username: 'jne-user', originCode: 'BDO10000', timeoutMs: 500, maxRetry: 0 },
  rajaongkir: { enabled: false, baseUrl: 'https://rajaongkir.test/api/v1', timeoutMs: 500, maxRetry: 1 },
} as unknown as ShippingConfig;

const PRICE = JSON.stringify({
  price: [{ origin_name: 'BANDUNG', destination_name: 'BOJONG SOANG', service_display: 'REG', service_code: 'REG23', goods_type: 'Paket', currency: 'IDR', price: '12000', etd_from: '1', etd_thru: '2', times: 'D' }],
});

type Mapping = { districtId: string; status: string; isActive: boolean; code: string; kind: string; locationActive: boolean };

/** A Prisma stand-in that applies the resolver's WHERE exactly as the database would. */
function prismaWith(mappings: Mapping[], districts = [{ id: 'dist-bojongsoang', code: '32.04.08', name: 'Bojongsoang', isActive: true, city: { name: 'Kabupaten Bandung', type: 'REGENCY', isActive: true } }]) {
  return {
    district: { findUnique: async ({ where }: { where: { code: string } }) => districts.find((d) => d.code === where.code) ?? null },
    jneDistrictMapping: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const l = where.jneLocation as { kind: string; isActive: boolean };
        const hit = mappings.find(
          (m) => m.districtId === where.districtId && m.isActive === where.isActive && m.status === where.status && m.kind === l.kind && m.locationActive === l.isActive,
        );
        return hit ? { jneLocation: { code: hit.code } } : null;
      },
      findMany: async ({ where }: { where: { districtId: string } }) =>
        mappings
          .filter((m) => m.districtId === where.districtId)
          .map((m) => ({
            status: m.status,
            isActive: m.isActive,
            method: 'MANUAL',
            confidence: 'STRONG',
            reviewedBy: m.status === 'MATCHED' ? 'ops-lead' : null,
            reviewedAt: m.status === 'MATCHED' ? new Date('2026-10-29T10:00:00Z') : null,
            createdAt: new Date('2026-10-29T09:00:00Z'),
            evidence: { sourceDataset: 'JNE list_dest', sourceVersion: 'sha256:361f00e8271d107f', evidenceSummary: 'kelurahan+postal 6/6' },
            jneLocation: { code: m.code, kind: m.kind, isActive: m.locationActive, source: 'SANDBOX', rawName: 'BOJONG SOANG,SOREANG' },
          })),
    },
  } as never;
}

const approved: Mapping = { districtId: 'dist-bojongsoang', status: 'MATCHED', isActive: true, code: 'BDO10104', kind: 'DESTINATION', locationActive: true };

const request = { destinationDistrictId: 'dist-bojongsoang', weightGram: 1000, originPostalCode: '40111', destinationPostalCode: '40288' } as ShippingRateRequest;

function jneWith(mappings: Mapping[]) {
  const provider = new JneProvider(config, new JneDestinationResolver(prismaWith(mappings)));
  const http = jest.fn(async () => ({ status: 200, text: async () => PRICE, headers: { get: () => null } }));
  (provider as unknown as { http: unknown }).http = http;
  return { provider, http };
}

class Paxel implements ShippingProvider {
  readonly name = 'paxel';
  async getRates(): Promise<ShippingQuote[]> {
    return [{ provider: 'paxel', service: 'PAXEL_SAMEDAY', serviceName: 'Paxel Same Day', estimatedDays: 'Today', shippingCost: 18000 }];
  }
  async track(trackingNumber: string) {
    return { provider: this.name, trackingNumber, status: 'OK', history: [] };
  }
}

describe('checkout with JNE destination mappings', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('an approved mapping takes the normal JNE rate path with the mapped destination code', async () => {
    const { provider, http } = jneWith([approved]);
    const quotes = await provider.getRates(request);
    expect(http).toHaveBeenCalledTimes(1);
    // The request carries the mapped destination code (JNE's `thru`).
    expect(JSON.stringify(http.mock.calls[0])).toContain('BDO10104');
    expect(quotes.length).toBeGreaterThan(0);
  });

  it.each([
    ['no mapping at all', []],
    ['a candidate still awaiting review', [{ ...approved, status: 'REVIEW_REQUIRED' }]],
    ['a deactivated mapping', [{ ...approved, isActive: false }]],
    ['an inactive destination', [{ ...approved, locationActive: false }]],
  ])('%s: no JNE request, no JNE quote, and a diagnostic naming the district', async (_what, mappings) => {
    const { provider, http } = jneWith(mappings as Mapping[]);
    await expect(provider.getRates(request)).resolves.toEqual([]);
    expect(http).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'jne', outcome: 'skipped', reason: 'no_jne_destination_mapping', destinationDistrictId: 'dist-bojongsoang' }),
    );
  });

  it('a missing JNE mapping leaves the other couriers in the checkout', async () => {
    const { provider } = jneWith([]);
    const service = new ShippingService(new ShippingProviderFactory([new Paxel(), provider]));
    const quotes = await service.getQuotes(request);
    expect(quotes.map((q) => q.provider)).toEqual(['paxel']);
  });
});

describe('JneDestinationDiagnostics', () => {
  const diagnose = (mappings: Mapping[]) => {
    const prisma = prismaWith(mappings);
    return new JneDestinationDiagnostics(prisma, new JneDestinationResolver(prisma)).forDistrictCode('32.04.08');
  };

  it('an approved mapping RESOLVES, with its provenance and reviewer', async () => {
    const d = await diagnose([approved]);
    expect(d).toMatchObject({ verdict: 'RESOLVES', resolvedCode: 'BDO10104', district: { name: 'Bojongsoang' } });
    expect(d.mappings[0]).toMatchObject({
      jneCode: 'BDO10104',
      status: 'MATCHED',
      method: 'MANUAL',
      confidence: 'STRONG',
      reviewedBy: 'ops-lead',
      evidence: { sourceDataset: 'JNE list_dest', sourceVersion: 'sha256:361f00e8271d107f' },
    });
  });

  it.each([
    ['NO_MAPPING', []],
    ['NOT_APPROVED', [{ ...approved, status: 'REVIEW_REQUIRED' }]],
    ['MAPPING_INACTIVE', [{ ...approved, isActive: false }]],
    ['LOCATION_NOT_USABLE', [{ ...approved, locationActive: false }]],
  ])('%s when the resolver does not answer', async (verdict, mappings) => {
    await expect(diagnose(mappings as Mapping[])).resolves.toMatchObject({ verdict, resolvedCode: null });
  });

  it('flags two active approvals for one district, which would make the resolver pick arbitrarily', async () => {
    const d = await diagnose([approved, { ...approved, code: 'BDO10109' }]);
    expect(d.warnings).toEqual(['MULTIPLE_ACTIVE_APPROVALS']);
    expect((await diagnose([approved])).warnings).toEqual([]);
  });

  it('an unknown district code', async () => {
    const prisma = prismaWith([], []);
    await expect(new JneDestinationDiagnostics(prisma, new JneDestinationResolver(prisma)).forDistrictCode('99.99.99')).resolves.toMatchObject({
      verdict: 'UNKNOWN_DISTRICT',
      district: null,
    });
  });
});
