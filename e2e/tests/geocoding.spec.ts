import { test, expect, request } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { tc, instrument } from '../utils/locators';
import { API_URL, CUSTOMER_URL, STORAGE } from '../utils/env';

/**
 * Module: SERVER-SIDE GEOCODING (GEO-001..003) — PAXELBOX-61AG.3.6.
 *
 * The first BROWSER-level proof of the geocoding flow. 61AG.3.5 already proved
 * the HTTP contract with supertest; what these tests add is that the REAL address
 * form, driven by a real Chromium, produces the same outcome — and specifically
 * that the coordinate Paxel is priced against comes from persisted server state,
 * not from anything the browser sent.
 *
 * The form is EXPECTED to submit latitude=0 / longitude=0 (it has no map picker;
 * see components/account/address-form.tsx). That is the point: the server must
 * replace the placeholder. Nothing about the frontend is changed to make this pass.
 *
 * Requires the isolated stack (disposable MySQL + stubbed Google/Paxel) — see the
 * 61AG.3.6 launcher. E2E_OUT_DIR points at its state files.
 */

const OUT_DIR = process.env.E2E_OUT_DIR ?? '';
const readJson = <T>(name: string): T =>
  JSON.parse(readFileSync(`${OUT_DIR}/${name}`, 'utf8')) as T;

interface StackState {
  customerTestId: string;
  product: { id: string; slug: string; name: string; price: number; imageUrl: string };
  expected: { latitude: number; longitude: number; paxelPrice: number };
}
interface PaxelCapture {
  counters: { google: number; paxel: number };
  calls: Array<{
    service_type: string;
    destination: { latitude?: number; longitude?: number; city?: string; district?: string };
  }>;
}

const state = readJson<StackState>('stack-ready.json');
const EXPECTED_LAT = state.expected.latitude;   // -6.9207623
const EXPECTED_LNG = state.expected.longitude;  // 107.6096701
const ADDRESS_LABEL = 'Rumah E2E';

/**
 * One PRE-EXISTING console error is tolerated: React warns about a <script> tag
 * rendered inside a component. It is unrelated to geocoding, predates this phase
 * and is explicitly out of scope to fix (PAXELBOX-61AG.3.6), so it is allowlisted
 * BY MESSAGE rather than by disabling the check — any other console error still
 * fails the test.
 */
const KNOWN_UNRELATED = [/Encountered a script tag while rendering React component/];
const unexpectedErrors = (lines: string[]) =>
  lines.filter((l) => l.startsWith('[error]') && !KNOWN_UNRELATED.some((re) => re.test(l)));

/**
 * Assert no unexpected console errors, quoting the failed network requests when
 * one fires. A bare "Failed to load resource: 404" says nothing on its own; the
 * URL is what makes it actionable.
 */
function expectCleanConsole(sink: { console: string[]; netFail: string[] }) {
  // HEADED-ONLY NOISE: Chromium's tab-icon request for /favicon.ico 404s, because
  // the app ships app/icon.svg and no favicon.ico. It is issued by the browser
  // chrome rather than the page, so it never reaches the page response handler and
  // carries no URL in its console line. It is tolerated ONLY when no page-level
  // request failed — a genuine 404 shows up in netFail and still fails the test.
  const bare404 = /Failed to load resource: the server responded with a status of 404/;
  const errors = unexpectedErrors(sink.console).filter(
    (l) => !(sink.netFail.length === 0 && bare404.test(l)),
  );
  expect(sink.netFail, 'no page request may fail').toHaveLength(0);
  expect(errors, `console errors: ${JSON.stringify(errors)}`).toHaveLength(0);
}

/**
 * Remove any address left by a previous run so the suite is idempotent. Uses the
 * API deliberately: this is fixture teardown, not the behaviour under test.
 */
async function clearTestAddresses() {
  const ctx = await request.newContext({ storageState: STORAGE.customer });
  const list = (await (await ctx.get(`${API_URL}/users/me/addresses`)).json()) as Array<Record<string, string>>;
  for (const a of list.filter((x) => x.label === ADDRESS_LABEL)) {
    await ctx.delete(`${API_URL}/users/me/addresses/${a.id}`);
  }
  await ctx.dispose();
}

/**
 * Drive one SearchableSelect.
 *
 * The trigger is a `role=combobox` button with NO accessible name — its
 * placeholder lives in a nested span — so it is located by its own text. The
 * match must be ANCHORED: "Pilih provinsi" is a prefix of the disabled city
 * trigger's "Pilih provinsi dulu", and an unanchored filter matches both.
 */
async function pickRegion(page: import('@playwright/test').Page, placeholder: string, option: string) {
  // These four placeholders contain no regex metacharacters, so they are used
  // literally; only the anchors are added.
  const trigger = page
    .getByRole('combobox')
    .filter({ hasText: new RegExp(String.raw`^\s*${placeholder}\s*$`, 'i') });
  await expect(trigger).toHaveCount(1);
  await trigger.click();
  // Anchored at the START only: village options append a postal-code hint, so
  // "Braga" renders as the option named "Braga 40111".
  await page.getByRole('option', { name: new RegExp(String.raw`^${option}(\s|$)`, 'i') }).click();
  // The trigger now shows the chosen name, which is how the next level unlocks.
  await expect(page.getByRole('combobox').filter({ hasText: option })).toHaveCount(1);
}

test.describe('Server-side geocoding — customer', () => {
  test.use({ storageState: STORAGE.customer });

  test('GEO-001 create address through the real UI; server replaces the 0,0 placeholder', async ({ page }, ti) => {
    tc(ti, 'GEO-001', '[Positive] Address created in the browser is geocoded server-side');
    const sink = { console: [] as string[], netFail: [] as string[] };
    instrument(page, sink);

    // Capture what the BROWSER actually posts, to prove the coordinates in the
    // response were not supplied by the client.
    let submitted: Record<string, unknown> | null = null;
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/users/me/addresses')) {
        try {
          submitted = JSON.parse(r.postData() ?? '{}');
        } catch {
          submitted = null;
        }
      }
    });

    await clearTestAddresses();
    await page.goto(`${CUSTOMER_URL}/account/addresses`);

    // Open the create dialog.
    await page.getByRole('button', { name: /Add address/i }).first().click();
    // Scoped by NAME: the region comboboxes leave a Radix popover in the DOM
    // that also carries role=dialog, so an unscoped locator is ambiguous.
    const dialog = page.getByRole('dialog', { name: /New address/i });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel(/^label$/i).fill(ADDRESS_LABEL);
    await dialog.getByLabel(/^Penerima$/i).fill('Smoke Test');
    await dialog.getByLabel(/^Telepon$/i).fill('081200000000');
    await dialog.getByLabel(/Alamat Lengkap/i).fill('Jl. Braga No. 1');

    // Dependent chain-select, strictly in order.
    await pickRegion(page, 'Pilih provinsi', 'Jawa Barat');
    await pickRegion(page, 'Pilih kota/kabupaten', 'Kota Bandung');
    await pickRegion(page, 'Pilih kecamatan', 'Sumur Bandung');
    await pickRegion(page, 'Pilih kelurahan/desa', 'Braga');

    // Postal code auto-fills from the village; never typed by hand.
    await expect(dialog.getByLabel(/Kode Pos/i)).toHaveValue('40111');

    await dialog.getByRole('button', { name: /Simpan alamat/i }).click();

    // UI result: the dialog closes and the new address is listed.
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText(ADDRESS_LABEL).first()).toBeVisible();

    // What the browser sent — expected to be the placeholder.
    expect(submitted, 'the create request was observed').not.toBeNull();
    // Cast through `unknown`: the value is assigned inside a page event handler,
    // which TypeScript's control-flow analysis cannot see.
    const posted = submitted as unknown as Record<string, number>;
    expect(Number(posted.latitude)).toBe(0);
    expect(Number(posted.longitude)).toBe(0);

    // What was persisted, read back through the real API with the same session.
    const ctx = await request.newContext({ storageState: STORAGE.customer });
    const res = await ctx.get(`${API_URL}/users/me/addresses`);
    expect(res.ok(), `address list failed: ${res.status()}`).toBeTruthy();
    const list = (await res.json()) as Array<Record<string, string>>;
    const created = list.find((a) => a.label === ADDRESS_LABEL);
    expect(created, 'created address is returned by the API').toBeTruthy();

    expect(Number(created!.latitude)).toBe(EXPECTED_LAT);
    expect(Number(created!.longitude)).toBe(EXPECTED_LNG);
    expect(Number(created!.latitude) === 0 && Number(created!.longitude) === 0).toBe(false);
    await ctx.dispose();

    expectCleanConsole(sink);
  });

  test('GEO-002 checkout renders the Paxel shipping options', async ({ page }, ti) => {
    tc(ti, 'GEO-002', '[Positive] Shipping options render for a geocoded address');
    const sink = { console: [] as string[], netFail: [] as string[] };
    instrument(page, sink);

    // Cart fixture: seeded into the persisted zustand store rather than driven
    // through the catalog UI. The cart is not what this phase is testing, and
    // seeding it keeps the test focused on address → geocoding → shipping.
    const line = {
      productId: state.product.id,
      slug: state.product.slug,
      name: state.product.name,
      price: state.product.price,
      imageUrl: state.product.imageUrl,
      qty: 2,
    };
    await page.addInitScript((l) => {
      window.localStorage.setItem('ms_cart', JSON.stringify({ state: { lines: [l] }, version: 0 }));
    }, line);

    await page.goto(`${CUSTOMER_URL}/checkout`);

    await expect(page.getByText(/Delivery address/i).first()).toBeVisible();

    // Select the address explicitly through the Radix Select rather than relying
    // on the page's auto-preselect effect, which did not fire in this run (see
    // the 61AG.3.6 report — observed, not fixed: production behaviour is out of
    // scope for this phase). Asserting on the TRIGGER text, not the hidden
    // native <option> the Select renders for form compatibility.
    const addressSelect = page.getByRole('combobox').filter({ hasText: /Select an address|Rumah E2E/ });
    await expect(addressSelect).toHaveCount(1);
    if (await page.getByRole('combobox', { name: /Select an address/i }).count()
      || (await addressSelect.innerText()).includes('Select an address')) {
      await addressSelect.click();
      await page.getByRole('option', { name: new RegExp(ADDRESS_LABEL) }).click();
    }
    await expect(addressSelect).toContainText(ADDRESS_LABEL, { timeout: 15_000 });

    // Shipping options must resolve — neither the empty nor the error state.
    const options = page.locator('button[aria-pressed]');
    await expect(options.first()).toBeVisible({ timeout: 20_000 });

    await expect(page.getByText(/No shipping services available/i)).toHaveCount(0);
    await expect(page.getByText(/Unable to load shipping options/i)).toHaveCount(0);

    await expect(options).toHaveCount(4);
    const text = await page.locator('button[aria-pressed]').allInnerTexts();
    const joined = text.join('\n');
    for (const label of ['Instant', 'Same Day', 'Next Day', 'Regular']) {
      expect(joined, `expected a ${label} service`).toContain(label);
    }

    // Rp 47.321 — the stub price. Proves the provider path ran, not a mock rate.
    const priced = await page.getByText(/Rp\s?47\.321/).count();
    expect(priced, 'stub price rendered').toBeGreaterThan(0);

    expectCleanConsole(sink);
  });

  test('GEO-003 the coordinate Paxel is priced against came from persisted state', async ({}, ti) => {
    tc(ti, 'GEO-003', '[Positive] Persisted coordinates bridge to the Paxel payload');

    const capture = readJson<PaxelCapture>('paxel-capture.json');
    expect(capture.calls.length, 'Paxel was called during checkout').toBeGreaterThan(0);

    for (const call of capture.calls) {
      expect(call.destination.latitude, `service ${call.service_type}`).toBe(EXPECTED_LAT);
      expect(call.destination.longitude, `service ${call.service_type}`).toBe(EXPECTED_LNG);
      expect(
        call.destination.latitude === 0 && call.destination.longitude === 0,
        'no Paxel request may carry the 0,0 placeholder',
      ).toBe(false);
    }

    // The browser posted 0,0 (asserted in GEO-001) and never sends coordinates to
    // /checkout/shipping-options at all — its DTO carries only address_id + items.
    // So the coordinate above can only have come from the persisted Address row.
    const distinct = new Set(capture.calls.map((c) => `${c.destination.latitude},${c.destination.longitude}`));
    expect(distinct.size, 'every service saw the same persisted coordinate').toBe(1);
    expect([...distinct][0]).toBe(`${EXPECTED_LAT},${EXPECTED_LNG}`);
  });

  test('GEO-004 the edit UI cannot produce 0,0, and the guard leaves real edits alone', async ({ page }, ti) => {
    tc(ti, 'GEO-004', '[Negative] Placeholder coordinates cannot overwrite a geocoded pin');
    const sink = { console: [] as string[], netFail: [] as string[] };
    instrument(page, sink);

    // PAXELBOX-61AG.3.7. Two halves, because the hole is only half reachable
    // from a browser:
    //
    //  (a) THROUGH THE REAL UI — open the edit dialog and save. The form seeds its
    //      hidden latitude/longitude inputs from the STORED address, so a normal
    //      edit re-sends the geocoded pin. This asserts what the browser actually
    //      puts on the wire, and that the new guard does not break ordinary edits.
    //
    //  (b) OVER HTTP with the same authenticated session — the 0,0 body itself.
    //      No control in the form can produce it, so this path belongs to an API
    //      caller, which is exactly who the guard exists to stop. It is a real
    //      request through routing, guard, pipe and controller; nothing is invoked
    //      directly.

    let patched: Record<string, unknown> | null = null;
    page.on('request', (r) => {
      if (r.method() === 'PATCH' && r.url().includes('/users/me/addresses')) {
        try {
          patched = JSON.parse(r.postData() ?? '{}');
        } catch {
          patched = null;
        }
      }
    });

    await page.goto(`${CUSTOMER_URL}/account/addresses`);
    await expect(page.getByText(ADDRESS_LABEL).first()).toBeVisible({ timeout: 15_000 });

    // (a) real edit through the dialog
    await page.getByRole('button', { name: /^Edit$/i }).first().click();
    const editDialog = page.getByRole('dialog', { name: /Edit address/i });
    await expect(editDialog).toBeVisible();
    await editDialog.getByLabel(/^Label$/i).fill('Rumah E2E');
    await editDialog.getByRole('button', { name: /Simpan alamat/i }).click();
    await expect(editDialog).toBeHidden({ timeout: 15_000 });

    // What the BROWSER sent: the stored pin, never the placeholder.
    expect(patched, 'the update request was observed').not.toBeNull();
    const sent = patched as unknown as Record<string, number>;
    expect(Number(sent.latitude)).toBe(EXPECTED_LAT);
    expect(Number(sent.longitude)).toBe(EXPECTED_LNG);
    expect(Number(sent.latitude) === 0 && Number(sent.longitude) === 0).toBe(false);

    const ctx = await request.newContext({ storageState: STORAGE.customer });
    const readBack = async () => {
      const list = (await (await ctx.get(`${API_URL}/users/me/addresses`)).json()) as Array<
        Record<string, string>
      >;
      return list.find((a) => a.label === ADDRESS_LABEL)!;
    };

    const afterUiEdit = await readBack();
    expect(Number(afterUiEdit.latitude), 'a normal UI edit keeps the pin').toBe(EXPECTED_LAT);
    expect(Number(afterUiEdit.longitude)).toBe(EXPECTED_LNG);

    // (b) the body the UI cannot produce
    const rejected = await ctx.patch(`${API_URL}/users/me/addresses/${afterUiEdit.id}`, {
      data: { latitude: 0, longitude: 0 },
    });
    expect(rejected.status(), 'the placeholder pair must be refused').toBe(400);
    expect(JSON.stringify(await rejected.json())).toMatch(/coordinate pair/i);

    const afterReject = await readBack();
    expect(Number(afterReject.latitude), 'a rejected patch is not a partial write').toBe(EXPECTED_LAT);
    expect(Number(afterReject.longitude)).toBe(EXPECTED_LNG);
    await ctx.dispose();

    expectCleanConsole(sink);
  });
});
