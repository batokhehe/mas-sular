import { BadRequestException } from '@nestjs/common';
import { ShippingService } from '../../src/modules/shipping/shipping.service';
import { ShippingProviderFactory } from '../../src/modules/shipping/shipping-provider.factory';
import { PaxelProvider } from '../../src/modules/shipping/infrastructure/providers/paxel.provider';
import { ShippingConfig } from '../../src/modules/shipping/shipping.config';
import { ShippingHttpRequest } from '../../src/modules/shipping/infrastructure/http/shipping-http-client';
import { ShippingProvider, ShippingQuote, ShippingRateRequest } from '../../src/modules/shipping/domain/shipping-provider.interface';

/**
 * Paxel INSTANT GOSEND is hidden from checkout at the SOURCE: the real
 * PaxelProvider never prices it, so the list ShippingService hands the
 * storefront (getQuotes) has no INSTANT, and an order naming it is refused by
 * the same server-side selection order creation uses. JNE is untouched.
 * Offline: Paxel's HTTP is stubbed, JNE is a fixed provider.
 */

const config: ShippingConfig = {
  allowMockRates: false,
  rajaongkir: { enabled: false, baseUrl: 'https://rajaongkir.invalid/api/v1', timeoutMs: 1000, maxRetry: 1 },
  paxel: {
    enabled: true,
    baseUrl: 'https://stage-commerce-api.paxel.test/v1',
    apiKey: 'test-api-key-not-a-real-secret',
    timeoutMs: 500,
    maxRetry: 0,
    defaultDimension: '30x35x20',
    needInsurance: false,
  },
  jne: { enabled: false, baseUrl: 'https://jne.test', timeoutMs: 500, maxRetry: 0 },
} as ShippingConfig;

const request: ShippingRateRequest = {
  originPostalCode: '40111',
  destinationPostalCode: '40132',
  weightGram: 1500,
  originAddress: 'Jl. Outlet No.1',
  originProvince: 'Jawa Barat',
  originCity: 'Kota Bandung',
  originDistrict: 'Coblong',
  destinationAddress: 'Jl. Tujuan No.2',
  destinationProvince: 'Jawa Barat',
  destinationCity: 'Kota Bandung',
  destinationDistrict: 'Sukasari',
};

const jneQuotes: ShippingQuote[] = [
  { provider: 'jne', service: 'REG', serviceName: 'JNE Regular', estimatedDays: '2-3 Days', shippingCost: 13000 },
  { provider: 'jne', service: 'YES', serviceName: 'JNE YES', estimatedDays: 'Tomorrow', shippingCost: 22000 },
];
const jne: ShippingProvider = {
  name: 'jne',
  getRates: async () => jneQuotes,
  track: async (trackingNumber: string) => ({ provider: 'jne', trackingNumber, status: 'OK', history: [] }),
};

function build() {
  const urls: string[] = [];
  const paxel = new PaxelProvider(config);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (paxel as any).http = async (url: string, init: ShippingHttpRequest) => {
    urls.push(url);
    const serviceType = JSON.parse(init.body as string).service_type as string;
    const price = { 'INSTANT GOSEND': 44000, SAMEDAY: 25000, NEXTDAY: 18000, REGULAR: 15000 }[serviceType];
    return {
      status: 200,
      text: async () => JSON.stringify({ data: { fixed_price: price, time_detail: [] } }),
      headers: { get: () => null },
    };
  };
  return { service: new ShippingService(new ShippingProviderFactory([paxel, jne])), urls };
}

describe('checkout shipping options without Paxel INSTANT GOSEND', () => {
  it('the options checkout shows carry no INSTANT; every other Paxel service and JNE are unchanged', async () => {
    const { service, urls } = build();
    const quotes = await service.getQuotes(request);

    expect(quotes.map((q) => `${q.provider}:${q.service}:${q.shippingCost}`)).toEqual([
      'paxel:PAXEL_SAMEDAY:25000',
      'paxel:PAXEL_NEXTDAY:18000',
      'paxel:PAXEL_REGULAR:15000',
      'jne:REG:13000',
      'jne:YES:22000',
    ]);
    expect(urls.filter((u) => u.endsWith('/rates/instant'))).toEqual([]);
  });

  it('an order selecting PAXEL_INSTANT is refused server-side', async () => {
    const { service } = build();
    await expect(service.findQuote(request, 'paxel', 'PAXEL_INSTANT')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('SAMEDAY, NEXTDAY, REGULAR and JNE remain selectable at their quoted price', async () => {
    const { service } = build();
    await expect(service.findQuote(request, 'paxel', 'PAXEL_SAMEDAY')).resolves.toMatchObject({ shippingCost: 25000 });
    await expect(service.findQuote(request, 'paxel', 'PAXEL_NEXTDAY')).resolves.toMatchObject({ shippingCost: 18000 });
    await expect(service.findQuote(request, 'paxel', 'PAXEL_REGULAR')).resolves.toMatchObject({ shippingCost: 15000 });
    await expect(service.findQuote(request, 'jne', 'REG')).resolves.toMatchObject({ shippingCost: 13000 });
  });
});
