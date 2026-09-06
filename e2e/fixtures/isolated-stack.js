/**
 * PAXELBOX-61AG.3.16 — the isolated E2E backend (B2).
 *
 * Runs as a CHILD PROCESS owned by Playwright's globalSetup. It provisions a
 * disposable MySQL 8.4 container, applies the repository's own Prisma migrations,
 * boots the smallest Nest graph the GEO tests need, replaces the Google and Paxel
 * HTTP transports with deterministic stubs, seeds minimal fixtures, and listens.
 *
 * WHY A CHILD PROCESS: every dependency it needs (testcontainers, @nestjs/*,
 * ts-node, @prisma/client) lives in backend/node_modules. Requiring them by
 * absolute path keeps the harness E2E-owned while adding no package to e2e/.
 *
 * ISOLATION IS FAIL-CLOSED. backend/.env is never read: DATABASE_URL is the
 * container's, and every credential is generated for this run. A hard guard
 * aborts before any write unless the live connection reports the disposable
 * database. Google, Paxel, JNE, Midtrans, Redis and RabbitMQ are all either
 * stubbed at their transport or absent from the module graph.
 *
 * Lifecycle: writes STATE_FILE when ready, then polls for SHUTDOWN_FILE — a flag
 * file rather than a signal, because SIGTERM is unreliable on Windows.
 *
 * Required env (supplied by global-setup.ts, never read from disk):
 *   BACKEND_DIR   absolute path to the backend workspace
 *   E2E_OUT_DIR   directory for stack-ready.json / paxel-capture.json / flags
 *   E2E_PORT      port to listen on
 *   E2E_ORIGINS   comma-separated CORS origins (the Playwright-owned frontend)
 *   E2E_JWT_SECRET  per-run secret; used to sign test sessions. Never logged.
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const BACKEND = process.env.BACKEND_DIR;
const OUT_DIR = process.env.E2E_OUT_DIR;
const PORT = Number(process.env.E2E_PORT);
const ORIGINS = (process.env.E2E_ORIGINS || '').split(',').filter(Boolean);
const JWT_SECRET = process.env.E2E_JWT_SECRET;

const STATE_FILE = path.join(OUT_DIR, 'stack-ready.json');
const CAPTURE_FILE = path.join(OUT_DIR, 'paxel-capture.json');
const SHUTDOWN_FILE = path.join(OUT_DIR, 'shutdown.flag');
const TEARDOWN_FILE = path.join(OUT_DIR, 'teardown.json');
const FAILED_FILE = path.join(OUT_DIR, 'failed.json');

/** Deterministic coordinates the Google stub returns. Jl. Braga No. 1, Bandung. */
const LAT = -6.9207623;
const LNG = 107.6096701;
/** Deterministic Paxel price — distinctive, so a mock-rate fallback is visible. */
const PAXEL_PRICE = 47321;

const log = (s) => console.log('[e2e-stack] ' + s);
let mysql = null;

const GOOGLE_BODY = JSON.stringify({
  status: 'OK',
  results: [{
    formatted_address: 'Jl. Braga No.1, Braga, Kec. Sumur Bandung, Kota Bandung, Jawa Barat 40111, Indonesia',
    geometry: { location: { lat: LAT, lng: LNG }, location_type: 'ROOFTOP' },
  }],
});

async function fail(message, err) {
  log('FAILED: ' + message + (err ? ' :: ' + (err.message || err) : ''));
  try { fs.writeFileSync(FAILED_FILE, JSON.stringify({ message, detail: err ? String(err.message || err) : null })); } catch { /* best effort */ }
  if (mysql) { try { await mysql.stop(); log('container destroyed after failure'); } catch { /* best effort */ } }
  process.exit(1);
}

(async () => {
  if (!BACKEND || !OUT_DIR || !PORT || !JWT_SECRET) {
    await fail('missing required environment (BACKEND_DIR / E2E_OUT_DIR / E2E_PORT / E2E_JWT_SECRET)');
  }
  for (const f of [STATE_FILE, CAPTURE_FILE, SHUTDOWN_FILE, TEARDOWN_FILE, FAILED_FILE]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }

  // ---------- disposable MySQL ----------
  log('starting disposable MySQL 8.4 ...');
  const { MySqlContainer } = require(path.join(BACKEND, 'node_modules/@testcontainers/mysql'));
  try {
    mysql = await new MySqlContainer('mysql:8.4')
      .withDatabase('e2e_isolated')
      .withUsername('e2e')
      // Generated per run; never a repository or developer credential.
      .withUserPassword(require('crypto').randomBytes(18).toString('hex'))
      .start();
  } catch (e) {
    await fail('could not start the disposable MySQL container (is Docker running?)', e);
  }
  const databaseUrl = mysql.getConnectionUri();
  log('container ' + mysql.getId().slice(0, 12) + '  db=' + mysql.getDatabase() + '  (credentials generated, not logged)');

  // Set BEFORE @prisma/client loads: dotenv semantics mean Prisma's own .env
  // injection cannot override an already-set value, so backend/.env can never win.
  process.env.DATABASE_URL = databaseUrl;
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET = JWT_SECRET;
  process.env.GEOCODING_ENABLED = 'true';
  process.env.GOOGLE_MAPS_API_KEY = 'e2e-stub-key-not-real';
  process.env.PAXEL_ENABLED = 'true';
  process.env.PAXEL_BASE_URL = 'https://paxel.invalid';
  process.env.PAXEL_API_KEY = 'e2e-stub';
  process.env.PAXEL_API_SECRET = 'e2e-stub';
  process.env.PAXEL_ORIGIN_PHONE = '081212121212';
  process.env.PAXEL_ORIGIN_NOTE = 'e2e';
  // Auth/CSRF posture is stated EXPLICITLY rather than inherited. Both of these
  // were previously reaching the harness only because backend/.env happened to
  // set them, which meant the security tests silently tracked whatever the
  // developer had configured locally — CSRF_MODE=off included, which is why
  // SEC-006/007/008 could never run. The suite mints an ms_access cookie, so
  // cookie auth must be on for those tests to mean anything.
  process.env.AUTH_COOKIE_EXTRACTOR_ENABLED = 'true';
  process.env.CSRF_MODE = 'enforce';
  // Every other integration stays OFF, so nothing can reach a live provider.
  delete process.env.JNE_ENABLED;
  delete process.env.RAJAONGKIR_ENABLED;
  delete process.env.MIDTRANS_ENABLED;
  delete process.env.REDIS_URL;
  delete process.env.RABBITMQ_URL;
  log('JNE / RajaOngkir / Midtrans disabled; REDIS_URL and RABBITMQ_URL removed from this process');

  // ---------- migrations ----------
  try {
    execSync('npx prisma migrate deploy', {
      cwd: BACKEND,
      env: Object.assign({}, process.env, { DATABASE_URL: databaseUrl }),
      stdio: 'inherit',
    });
  } catch (e) {
    await fail('prisma migrate deploy failed against the disposable database', e);
  }

  // ---------- Nest ----------
  require(path.join(BACKEND, 'node_modules/ts-node')).register({
    project: path.join(BACKEND, 'tsconfig.json'),
    transpileOnly: true,
    compilerOptions: { module: 'commonjs' },
  });
  require(path.join(BACKEND, 'node_modules/reflect-metadata'));

  const { ValidationPipe, VersioningType } = require(path.join(BACKEND, 'node_modules/@nestjs/common'));
  const { ConfigModule } = require(path.join(BACKEND, 'node_modules/@nestjs/config'));
  const { PassportModule } = require(path.join(BACKEND, 'node_modules/@nestjs/passport'));
  const { Test } = require(path.join(BACKEND, 'node_modules/@nestjs/testing'));
  const cookieParser = require(path.join(BACKEND, 'node_modules/cookie-parser'));

  const { MetricsModule } = require(path.join(BACKEND, 'src/infrastructure/metrics/metrics.module'));
  const { DatabaseModule } = require(path.join(BACKEND, 'src/database/database.module'));
  const { PrismaService } = require(path.join(BACKEND, 'src/database/prisma.service'));
  const { JwtStrategy } = require(path.join(BACKEND, 'src/modules/auth/infrastructure/jwt.strategy'));
  const { UsersModule } = require(path.join(BACKEND, 'src/modules/users/users.module'));
  const { OrdersModule } = require(path.join(BACKEND, 'src/modules/orders/orders.module'));
  const { RegionsModule } = require(path.join(BACKEND, 'src/modules/regions/regions.module'));
  const { GeocodingService } = require(path.join(BACKEND, 'src/modules/geocoding/geocoding.service'));
  const { PaxelProvider } = require(path.join(BACKEND, 'src/modules/shipping/infrastructure/providers/paxel.provider'));

  let app;
  try {
    const moduleRef = await Test.createTestingModule({
      imports: [
        // ignoreEnvFile: backend/.env is never read by this process.
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ jwt: { accessSecret: JWT_SECRET, accessTtl: '1d' } })],
        }),
        PassportModule,
        MetricsModule,   // @Global; ShipmentModule (reached via payments) needs it
        DatabaseModule,
        UsersModule,     // + GeocodingModule
        OrdersModule,    // + ShippingModule (Paxel), Idempotency, PaymentGateway
        RegionsModule,   // the address form's chain-select
      ],
      providers: [JwtStrategy],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());                                    // httpOnly ms_access
    app.enableCors({ origin: ORIGINS, credentials: true });     // Playwright-owned frontend only
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(new ValidationPipe({
      whitelist: true, forbidNonWhitelisted: true, transform: true,
      transformOptions: { enableImplicitConversion: true },
    }));
    await app.init();
  } catch (e) {
    await fail('could not boot the isolated Nest application', e);
  }

  const prisma = app.get(PrismaService);

  // ---------- HARD ISOLATION GUARD ----------
  const liveDb = (await prisma.$queryRawUnsafe('SELECT DATABASE() AS db'))[0].db;
  const addressRows = await prisma.address.count();
  log('SELECT DATABASE() = ' + liveDb + ' ; Address rows = ' + addressRows);
  if (liveDb !== 'e2e_isolated' || addressRows !== 0) {
    await app.close();
    await fail('isolation guard REFUSED: connected database is "' + liveDb + '" with ' + addressRows + ' address rows');
  }
  log('isolation guard PASSED (empty disposable database)');

  // ---------- transport stubs ----------
  const counters = { google: 0, paxel: 0 };
  const paxelCalls = [];

  const geocoding = app.get(GeocodingService, { strict: false });
  geocoding.http = async () => {
    counters.google += 1;
    return { status: 200, text: async () => GOOGLE_BODY };
  };

  const paxel = app.get(PaxelProvider, { strict: false });
  paxel.http = async (url, init) => {
    counters.paxel += 1;
    const body = JSON.parse(String(init.body));
    // Only the fields under assertion are captured; the URL is never recorded.
    paxelCalls.push({ service_type: body.service_type, origin: body.origin, destination: body.destination });
    fs.writeFileSync(CAPTURE_FILE, JSON.stringify({ counters, calls: paxelCalls }, null, 2));
    return {
      status: 200,
      text: async () => JSON.stringify({ data: { fixed_price: PAXEL_PRICE, fixed_size: 'S' } }),
      headers: { get: () => null },
    };
  };
  log('Google + Paxel transports stubbed — a real call is not reachable from this process');

  // ---------- minimal fixtures (GEO-001..004 only) ----------
  const province = await prisma.province.create({ data: { code: '32', name: 'Jawa Barat' } });
  const city = await prisma.city.create({ data: { code: '3273', name: 'Kota Bandung', type: 'CITY', provinceId: province.id } });
  const district = await prisma.district.create({ data: { code: '3273031', name: 'Sumur Bandung', cityId: city.id } });
  const village = await prisma.village.create({ data: { code: '3273031005', name: 'Braga', districtId: district.id, postalCode: '40111' } });
  const originDistrict = await prisma.district.create({ data: { code: '3273090', name: 'Buahbatu', cityId: city.id } });
  const originVillage = await prisma.village.create({ data: { code: '3273090001', name: 'Jatisari', districtId: originDistrict.id, postalCode: '40286' } });
  // An active outlet is the shipping ORIGIN; without one there is no quote.
  await prisma.outlet.create({
    data: {
      name: 'E2E Outlet', addressDetail: 'Jl. Outlet No. 9', isActive: true, postalCode: '40286',
      provinceId: province.id, cityId: city.id, districtId: originDistrict.id, villageId: originVillage.id,
      latitude: -6.9532467, longitude: 107.6630995,
    },
  });
  // One product: checkout needs weightGram to quote, and GEO-002 seeds it into the cart.
  const category = await prisma.category.create({ data: { name: 'E2E', slug: 'e2e-category' } });
  const product = await prisma.product.create({
    data: {
      slug: 'e2e-product', sku: 'E2E-SKU-001', name: 'E2E Product', description: 'e2e fixture',
      price: 30000, imageUrl: '/placeholder.jpg', stock: 50, categoryId: category.id, weightGram: 500,
    },
  });
  const user = await prisma.user.create({
    data: { email: 'e2e.customer@masular.test', name: 'E2E Customer', isOnboarded: true },
  });
  log('minimal GEO fixtures seeded (regions, outlet, product, customer)');

  await app.listen(PORT, '127.0.0.1');
  const backendUrl = 'http://localhost:' + PORT;
  log('listening on ' + backendUrl + '  (prefix /api, version v1)');

  // ---------- stack state: NON-SECRET ONLY ----------
  // No connection string, no password, no JWT secret, no API key. The secret is
  // held by global-setup.ts in memory and handed to auth.setup.ts via process.env.
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    backendUrl,
    apiUrl: backendUrl + '/api/v1',
    database: 'e2e_isolated (disposable container)',
    customerTestId: user.id,
    customerTestEmail: user.email,
    product: { id: product.id, slug: product.slug, name: product.name, price: 30000, imageUrl: '/placeholder.jpg' },
    expected: { latitude: LAT, longitude: LNG, paxelPrice: PAXEL_PRICE },
  }, null, 2));
  log('READY — stack-ready.json written (contains no secrets)');

  // ---------- wait for teardown ----------
  const poll = setInterval(async () => {
    if (!fs.existsSync(SHUTDOWN_FILE)) return;
    clearInterval(poll);
    log('shutdown requested');
    let counts = null;
    try {
      counts = {
        Address: await prisma.address.count(),
        User: await prisma.user.count(),
        Outlet: await prisma.outlet.count(),
      };
    } catch { /* the container may already be going away */ }
    try { await app.close(); } catch { /* best effort */ }
    try { await mysql.stop(); mysql = null; } catch { /* best effort */ }
    fs.writeFileSync(TEARDOWN_FILE, JSON.stringify({ counters, countsAtShutdown: counts, containerDestroyed: true }, null, 2));
    log('backend stopped, container destroyed — stub invocations ' + JSON.stringify(counters));
    process.exit(0);
  }, 500);
})().catch((e) => fail('unhandled error', e));
