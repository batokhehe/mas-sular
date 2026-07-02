import { Page, TestInfo, expect } from '@playwright/test';

/** Attach a TC ID + scenario to the test for traceability into the Excel/report. */
export function tc(testInfo: TestInfo, id: string, scenario: string) {
  testInfo.annotations.push({ type: 'tc-id', description: id });
  testInfo.annotations.push({ type: 'scenario', description: scenario });
}

/** Wire console + network capture; dumps to artifacts/logs on demand. */
export function instrument(page: Page, sink: { console: string[]; netFail: string[] }) {
  page.on('console', (m) => sink.console.push(`[${m.type()}] ${m.text()}`));
  page.on('requestfailed', (r) =>
    sink.netFail.push(`${r.method()} ${r.url()} — ${r.failure()?.errorText ?? 'failed'}`),
  );
  page.on('response', (r) => {
    if (r.status() >= 400) sink.netFail.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
}

/** Prefer role/label/text. Fallback chain keeps locators resilient (no brittle CSS). */
export function clickByName(page: Page, role: Parameters<Page['getByRole']>[0], name: RegExp | string) {
  return page.getByRole(role, { name }).first().click();
}

export async function expectVisibleText(page: Page, text: RegExp | string) {
  await expect(page.getByText(text).first()).toBeVisible();
}
