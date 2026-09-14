import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Regression for the RabbitMQ readiness probe.
 *
 * The probe used `import amqp from 'amqplib'`, which under `module: commonjs`
 * WITHOUT `esModuleInterop` emits `amqplib_1.default.connect(...)`. amqplib is
 * CommonJS with no `default` export, so that threw
 * "Cannot read properties of undefined (reading 'connect')" before any socket was
 * opened — making readiness a permanent false negative on every environment.
 *
 * These tests never open a real connection and never touch a database.
 */

const connectMock = jest.fn();
jest.mock('amqplib', () => ({ connect: (...args: unknown[]) => connectMock(...args) }));

// Imported after the mock so the controller binds to it.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HealthController } = require('../../src/health.controller') as typeof import('../../src/health.controller');
const { RabbitConnectionManager } = require('../../src/infrastructure/outbox/rabbit-connection.manager') as typeof import('../../src/infrastructure/outbox/rabbit-connection.manager');

const RABBIT_URL = 'amqps://user:pass@broker.example.test:5671/vhost';

function controller(opts: { redisOk?: boolean; postgresOk?: boolean } = {}) {
  const prisma = {
    $queryRaw: jest.fn(async () => {
      if (opts.postgresOk === false) throw new Error('db down');
      return [{ 1: 1 }];
    }),
  };
  const cache = {
    set: jest.fn(async () => undefined),
    get: jest.fn(async () => (opts.redisOk === false ? 'nope' : 'ok')),
  };
  // L4: readiness probes the SHARED connection manager (the real one, over the mock).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rabbit = new RabbitConnectionManager({ rabbitmqUrl: process.env.RABBITMQ_URL } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new HealthController(prisma as any, cache as any, rabbit);
}

// Readiness answers with an HTTP STATUS CODE as well as a body (F69). These
// tests hand the controller a minimal Express Response stand-in; `status()` is
// the only method it touches.
type ResStub = { code: number; status: jest.Mock };
function mockRes(): ResStub {
  const res: ResStub = { code: 0, status: jest.fn() };
  res.status.mockImplementation((code: number) => {
    res.code = code;
    return res;
  });
  return res;
}

/** Invokes the readiness handler and returns both halves of its answer. */
async function probe(opts: { redisOk?: boolean; postgresOk?: boolean } = {}) {
  const http = mockRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = await controller(opts).ready(http as any);
  return { body, code: http.code };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ORIGINAL_ENV, RABBITMQ_URL: RABBIT_URL };
});
afterAll(() => { process.env = ORIGINAL_ENV; });

// ================================================= the import itself ========

describe('the amqplib import shape', () => {
  it('amqplib exposes connect at the module root, and has NO default export', () => {
    const actual = jest.requireActual('amqplib') as Record<string, unknown>;
    expect(typeof actual.connect).toBe('function');
    // This is the whole reason a default import cannot work.
    expect(actual.default).toBeUndefined();
  });

  it('the connection manager the probe relies on uses the namespace import', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'infrastructure', 'outbox', 'rabbit-connection.manager.ts'), 'utf8');
    expect(src).toMatch(/import \* as amqp from 'amqplib'/);
    // A default import here would compile fine and fail at runtime.
    expect(src).not.toMatch(/^import amqp from 'amqplib'/m);
  });

  it('L4: the health controller no longer opens its own AMQP connections', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'health.controller.ts'), 'utf8');
    expect(src).not.toMatch(/from 'amqplib'/);
    expect(src).not.toMatch(/amqp\.connect\(/);
  });
});

// =================================================== the probe behaviour ====

describe('RabbitMQ readiness probe', () => {
  it('connects the SHARED connection with the configured RABBITMQ_URL and reports ok', async () => {
    const close = jest.fn(async () => undefined);
    connectMock.mockResolvedValue({ close, on: jest.fn() });

    const { body: result, code } = await probe();

    expect(code).toBe(200);
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledWith(RABBIT_URL);
    // L4: the shared connection belongs to the relay/consumers; a probe never closes it.
    expect(close).not.toHaveBeenCalled();
    expect(result.checks.rabbitmq).toBe('ok');
    expect(result.status).toBe('ready');
  });

  it('reports failed — not a crash — when the broker refuses the connection', async () => {
    connectMock.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));

    const { body: result, code } = await probe();

    expect(code).toBe(503);
    expect(result.checks.rabbitmq).toBe('failed');
    expect(result.status).toBe('not_ready');
  });

  it('would have caught the original defect: a connect that is not a function', async () => {
    // Simulates `amqplib_1.default.connect` being undefined.
    connectMock.mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'connect')");
    });

    const { body: result, code } = await probe();
    expect(result.checks.rabbitmq).toBe('failed'); // never crashes the endpoint
    expect(code).toBe(503); // and it is a 503, not a 500 or a misleading 200
  });
});

// ============================================= unchanged health semantics ===

describe('health response semantics are unchanged', () => {
  it('skips RabbitMQ when no URL is configured and nothing requires it', async () => {
    delete process.env.RABBITMQ_URL;
    delete process.env.OUTBOX_RELAY_ENABLED;
    delete process.env.CONSUMERS_ENABLED;
    connectMock.mockResolvedValue({ close: jest.fn() });

    const { body: result, code } = await probe();

    expect(connectMock).not.toHaveBeenCalled();
    expect(result.checks.rabbitmq).toBe('skipped');
    expect(result.status).toBe('ready'); // skipped does not block readiness
    expect(code).toBe(200);
  });

  it('fails when RabbitMQ is required but no URL is configured', async () => {
    delete process.env.RABBITMQ_URL;
    process.env.OUTBOX_RELAY_ENABLED = 'true';

    const { body: result, code } = await probe();

    expect(result.checks.rabbitmq).toBe('failed');
    expect(result.status).toBe('not_ready');
    expect(code).toBe(503);
  });

  it('still reports the other dependencies independently', async () => {
    connectMock.mockResolvedValue({ close: jest.fn(), on: jest.fn() });

    const postgresDown = await probe({ postgresOk: false });
    expect(postgresDown.body.checks.postgres).toBe('failed');
    expect(postgresDown.body.checks.rabbitmq).toBe('ok');
    expect(postgresDown.body.status).toBe('not_ready');
    expect(postgresDown.code).toBe(503);

    const redisDown = await probe({ redisOk: false });
    expect(redisDown.body.checks.redis).toBe('failed');
    expect(redisDown.body.status).toBe('not_ready');
    expect(redisDown.code).toBe(503);
  });

  it('/health stays a static liveness answer', () => {
    const body = controller().health();
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
    expect(typeof body.timestamp).toBe('string');
  });
});
