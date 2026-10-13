import { readFileSync } from 'fs';
import { join } from 'path';
import { validateEnv } from '../../src/common/config/env.validation';
import {
  JNE_PICKUP_ENV,
  JNE_PICKUP_SERVICES,
  JNE_PICKUP_TYPES,
  JNE_PICKUP_VEHICLES,
  jnePickupConfigIssues,
  loadJnePickupConfig,
  loadShippingConfig,
} from '../../src/modules/shipping/shipping.config';

/**
 * JNE /pickupcashless merchant & pickup master data lives in the environment:
 * required when JNE is enabled, validated against the documented enumerations, and
 * never defaulted. All values here are placeholder fixtures, not real JNE data.
 */

const PICKUP_ENV: Record<string, string> = {
  JNE_PICKUP_NAME: 'Pickup Test',
  JNE_PICKUP_PIC: 'Pic Test',
  JNE_PICKUP_PIC_PHONE: '081200000001',
  JNE_PICKUP_ADDRESS: 'Jl. Test 1',
  JNE_PICKUP_DISTRICT: 'District Test',
  JNE_PICKUP_CITY: 'City Test',
  JNE_PICKUP_SERVICE: 'Intracity',
  JNE_PICKUP_VEHICLE: 'Mobil',
  JNE_BRANCH: 'BRANCH-TEST',
  JNE_CUST_ID: 'CUST-TEST',
  JNE_MERCHANT_ID: 'MERCHANT-TEST',
  JNE_SHIPPER_NAME: 'Shipper Test',
  JNE_SHIPPER_ADDR1: 'Jl. Test 1',
  JNE_SHIPPER_ADDR2: 'Kel. Test',
  JNE_SHIPPER_CITY: 'City Test',
  JNE_SHIPPER_ZIP: '40111',
  JNE_SHIPPER_REGION: 'Region Test',
  JNE_SHIPPER_CONTACT: 'Contact Test',
  JNE_SHIPPER_PHONE: '081200000002',
  JNE_TYPE: 'DROP',
};

const BASE: Record<string, string> = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://u:p@db:5432/app',
  REDIS_URL: 'redis://redis:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  JWT_ADMIN_ACCESS_SECRET: 'c'.repeat(32),
  GOOGLE_CLIENT_ID: 'google-client-id',
  APP_URL: 'https://shop.example.com',
  CORS_ORIGINS: 'https://shop.example.com',
  CHECKOUT_IDEMPOTENCY_ENABLED: 'true',
  TRUST_PROXY_HOPS: '1',
  JNE_ENABLED: 'true',
  JNE_API_KEY: 'k',
  JNE_USERNAME: 'u',
  JNE_ORIGIN_CODE: 'BDO10000',
};

const errorOf = (env: Record<string, string | undefined>): string => {
  try {
    validateEnv(env);
  } catch (err) {
    return (err as Error).message;
  }
  return '';
};

describe('the documented enumerations', () => {
  it('match the JNE documentation exactly (case-sensitive)', () => {
    expect([...JNE_PICKUP_SERVICES]).toEqual(['Domestic', 'Intracity', 'All']);
    expect([...JNE_PICKUP_VEHICLES]).toEqual(['Motor', 'Mobil', 'Truck']);
    expect([...JNE_PICKUP_TYPES]).toEqual(['DROP', 'PICKUP']);
  });

  it('covers exactly the 20 configured values', () => {
    expect(Object.values(JNE_PICKUP_ENV).sort()).toEqual(Object.keys(PICKUP_ENV).sort());
  });
});

describe('loading', () => {
  it('reads every value, trimmed', () => {
    const cfg = loadJnePickupConfig({ ...PICKUP_ENV, JNE_PICKUP_NAME: '  Pickup Test  ' } as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({ pickupName: 'Pickup Test', pickupService: 'Intracity', pickupVehicle: 'Mobil', type: 'DROP', custId: 'CUST-TEST' });
  });

  it('an empty placeholder means UNSET, never an empty string sent to JNE', () => {
    const cfg = loadJnePickupConfig({ JNE_CUST_ID: '', JNE_TYPE: '   ' } as NodeJS.ProcessEnv);
    expect(cfg.custId).toBeUndefined();
    expect(cfg.type).toBeUndefined();
  });

  it('is wired into the shipping config', () => {
    expect(loadShippingConfig({ ...BASE, ...PICKUP_ENV } as NodeJS.ProcessEnv).jne.pickup).toMatchObject({ branch: 'BRANCH-TEST', merchantId: 'MERCHANT-TEST' });
  });

  it('no value has a default', () => {
    expect(Object.values(loadJnePickupConfig({} as NodeJS.ProcessEnv)).every((v) => v === undefined)).toBe(true);
  });
});

describe('issues', () => {
  it('a complete, valid set has none', () => {
    expect(jnePickupConfigIssues(loadJnePickupConfig(PICKUP_ENV as NodeJS.ProcessEnv))).toEqual([]);
  });

  it('every missing value is named by its env var', () => {
    expect(jnePickupConfigIssues(undefined)).toEqual(Object.values(JNE_PICKUP_ENV).map((key) => `${key} is required`));
  });

  it('an invalid enum value is reported with the documented options', () => {
    const issues = jnePickupConfigIssues(loadJnePickupConfig({ ...PICKUP_ENV, JNE_PICKUP_VEHICLE: 'Becak', JNE_TYPE: 'pickup' } as NodeJS.ProcessEnv));
    expect(issues).toEqual(['JNE_PICKUP_VEHICLE must be one of Motor | Mobil | Truck', 'JNE_TYPE must be one of DROP | PICKUP']);
  });
});

describe('boot validation (env.validation)', () => {
  it('an enabled courier with the complete set boots', () => {
    expect(errorOf({ ...BASE, ...PICKUP_ENV })).toBe('');
  });

  it('an enabled courier WITHOUT the set refuses to boot and names every missing key', () => {
    const message = errorOf({ ...BASE });
    for (const key of Object.values(JNE_PICKUP_ENV)) expect(message).toContain(`${key} is required when JNE_ENABLED=true`);
  });

  it.each(Object.keys(PICKUP_ENV))('missing %s alone refuses to boot', (key) => {
    expect(errorOf({ ...BASE, ...PICKUP_ENV, [key]: undefined })).toContain(`${key} is required when JNE_ENABLED=true`);
  });

  it('an empty placeholder counts as missing when JNE is enabled', () => {
    expect(errorOf({ ...BASE, ...PICKUP_ENV, JNE_CUST_ID: '' })).toContain('JNE_CUST_ID is required when JNE_ENABLED=true');
  });

  it.each([
    ['JNE_PICKUP_SERVICE', 'domestic'],
    ['JNE_PICKUP_VEHICLE', 'Sepeda'],
    ['JNE_TYPE', 'COURIER'],
  ])('%s=%s is rejected at boot', (key, value) => {
    expect(errorOf({ ...BASE, ...PICKUP_ENV, [key]: value })).toMatch(new RegExp(key));
  });

  it('JNE disabled: the empty template placeholders boot fine (nothing is required)', () => {
    const empty = Object.fromEntries(Object.keys(PICKUP_ENV).map((key) => [key, '']));
    expect(errorOf({ ...BASE, JNE_ENABLED: 'false', ...empty })).toBe('');
  });

  it('JNE disabled: a set-but-INVALID enum is still a misconfiguration', () => {
    expect(errorOf({ ...BASE, JNE_ENABLED: 'false', JNE_TYPE: 'COURIER' })).toMatch(/JNE_TYPE/);
  });
});

describe('production.env.example', () => {
  const template = readFileSync(join(__dirname, '../../../production.env.example'), 'utf8');

  it.each(Object.keys(PICKUP_ENV))('declares %s as an EMPTY placeholder (no real value)', (key) => {
    expect(template).toMatch(new RegExp(`^${key}=$`, 'm'));
  });
});
