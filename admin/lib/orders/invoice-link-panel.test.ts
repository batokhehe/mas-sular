import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * P2 #14 — Admin Order Detail: "Print Invoice" became the customer invoice link.
 *
 * No component-render harness exists in this package, so this pins the wiring in
 * the source; the endpoints' behaviour is tested in the backend and the flow in
 * the browser (see the #14 report).
 */

const strip = (src: string) => src.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (p: string) => strip(readFileSync(join(process.cwd(), p), 'utf8'));
const PAGE = read('app/orders/[id]/page.tsx');
const PANEL = read('app/orders/components/invoice-link-panel.tsx');
const API = read('lib/admin.ts');

test('17. Order Detail shows the invoice panel instead of printing the Admin page', () => {
  assert.equal(/Print Invoice/.test(PAGE), false, 'the window.print() "Print Invoice" button is gone');
  assert.match(PAGE, /<InvoiceLinkPanel orderId=\{order\.id\} recipientPhone=\{order\.address\?\.phone \?\? order\.user\?\.phone \?\? null\} \/>/);
  // 21. the rest of the Quick Actions are untouched.
  for (const kept of ['Verify Payment', 'Reject Payment', 'Retry Shipment', 'Cancel Order', 'Download Receipt', 'Open Tracking', 'Print Packing Slip']) {
    assert.ok(PAGE.includes(kept), `kept: ${kept}`);
  }
});

test('the panel talks to the three invoice-link endpoints only', () => {
  assert.match(API, /api<InvoiceLinkStatus>\(`\/admin\/orders\/\$\{orderId\}\/invoice-link`\)/);
  assert.match(API, /api<IssuedInvoiceLink>\(`\/admin\/orders\/\$\{orderId\}\/invoice-link`, \{ method: 'POST' \}\)/);
  assert.match(API, /api<SentInvoiceLink>\(`\/admin\/orders\/\$\{orderId\}\/invoice-link\/whatsapp`, \{ method: 'POST' \}\)/);
});

test('18. generate / copy / open / print all use the link the backend just returned', () => {
  assert.match(PANEL, /action: async \(\) => refreshAfterIssue\(await createInvoiceLink\(orderId\)\)/);
  assert.match(PANEL, /navigator\.clipboard\.writeText\(link\.invoiceUrl\)/);
  // Print opens the CUSTOMER page in print mode - not window.print() on the Admin.
  assert.match(PANEL, /window\.open\(print \? `\$\{link\.invoiceUrl\}\?print=1` : link\.invoiceUrl, '_blank', 'noopener,noreferrer'\)/);
  assert.equal(/window\.print\(/.test(PANEL), false);
  // A new link replaces an active one only after an explicit confirmation.
  assert.match(PANEL, /confirm: active \|\| link \? \(\) => confirmApprove\(\{ title: 'Create a new invoice link\?', text: 'The current invoice link will stop working\.' \}\) : undefined/);
});

test('19/20. WhatsApp: confirmed, sent through the backend, success means "queued", failures are shown', () => {
  assert.match(PANEL, /const res = await sendInvoiceLinkWhatsApp\(orderId\)/);
  assert.match(PANEL, /WhatsApp message queued \(\$\{res\.notification\.status\}\)\. Delivery status appears in Notification History\./);
  assert.match(PANEL, /runWithFeedback\(\{\s*confirm: \(\) =>\s*confirmApprove\(\{\s*title: 'Send invoice via WhatsApp\?'/);
  // runWithFeedback shows the backend error (e.g. "WHATSAPP manual sends are not configured") on failure.
  assert.match(read('lib/admin-alert.ts'), /void showError\(caught\)/);
  // Notification History refreshes so the queued row appears.
  assert.match(PANEL, /qc\.invalidateQueries\(\{ queryKey: \['admin-order-ops', orderId\] \}\)/);
});

test('actions are permission-gated like the backend (create: Order.update; WhatsApp: + Notification.send)', () => {
  assert.match(PANEL, /<PermissionGate permissions=\{ROUTE_PERMISSIONS\.orderUpdate\}>/);
  assert.match(PANEL, /<PermissionGate permissions=\{\[\.\.\.ROUTE_PERMISSIONS\.orderUpdate, \.\.\.ROUTE_PERMISSIONS\.notificationSend\]\}>/);
});

test('the link is never logged or kept beyond the page state', () => {
  assert.equal(/console\.|localStorage|sessionStorage/.test(PANEL), false);
});
