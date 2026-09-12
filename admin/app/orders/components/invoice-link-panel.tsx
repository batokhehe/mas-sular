'use client';

import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, ExternalLink, FileText, MessageCircle, Printer } from 'lucide-react';
import { PermissionGate } from '@/components/auth/permission-gate';
import { Card, CardTitle } from '@/components/ui/card';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { createInvoiceLink, fetchInvoiceLinkStatus, IssuedInvoiceLink, sendInvoiceLinkWhatsApp } from '@/lib/admin';
import { confirmApprove, runWithFeedback, showError, showSuccess } from '@/lib/admin-alert';

const dt = (iso: string) => new Date(iso).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * P2 #14: customer-facing invoice link (replaces printing the Admin page).
 *
 * The backend stores only a hash of the link, so the link is available here only
 * in the response to the action that created it; after a reload the panel shows
 * the active link's dates and offers a new one. Creating or sending a new link
 * stops the previous one. The link is never logged from here.
 */
export function InvoiceLinkPanel({ orderId, recipientPhone }: { orderId: string; recipientPhone: string | null }) {
  const qc = useQueryClient();
  const [link, setLink] = useState<IssuedInvoiceLink | null>(null);

  const statusQ = useQuery({
    queryKey: ['admin-order-invoice-link', orderId],
    queryFn: () => fetchInvoiceLinkStatus(orderId),
    retry: false,
  });
  const active = statusQ.data?.active ?? null;

  const refreshAfterIssue = (issued: IssuedInvoiceLink) => {
    setLink({ invoiceUrl: issued.invoiceUrl, createdAt: issued.createdAt, expiresAt: issued.expiresAt });
    void qc.invalidateQueries({ queryKey: ['admin-order-invoice-link', orderId] });
  };

  const create = () =>
    runWithFeedback({
      confirm: active || link ? () => confirmApprove({ title: 'Create a new invoice link?', text: 'The current invoice link will stop working.' }) : undefined,
      loading: 'Creating invoice link...',
      success: 'Invoice link created',
      action: async () => refreshAfterIssue(await createInvoiceLink(orderId)),
    });

  const sendWhatsApp = () =>
    runWithFeedback({
      confirm: () =>
        confirmApprove({
          title: 'Send invoice via WhatsApp?',
          text: `A new invoice link will be sent to ${recipientPhone ?? 'the customer'}. Any previous invoice link stops working.`,
        }),
      loading: 'Queueing WhatsApp message...',
      // Accepted into the notification queue - delivery is reported in Notification History.
      success: (res: Awaited<ReturnType<typeof sendInvoiceLinkWhatsApp>>) =>
        `WhatsApp message queued (${res.notification.status}). Delivery status appears in Notification History.`,
      action: async () => {
        const res = await sendInvoiceLinkWhatsApp(orderId);
        refreshAfterIssue(res);
        void qc.invalidateQueries({ queryKey: ['admin-order-ops', orderId] });
        return res;
      },
    });

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.invoiceUrl);
      showSuccess('Invoice link copied');
    } catch (err) {
      void showError(err instanceof Error ? err : new Error('Could not copy the link - select it and copy manually.'));
    }
  };
  // noopener/noreferrer: the invoice tab gets no handle on the Admin, and the Admin URL is not sent as Referer.
  const openInvoice = (print = false) => {
    if (link) window.open(print ? `${link.invoiceUrl}?print=1` : link.invoiceUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <Card className="mb-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-gray-400" />
          <CardTitle>Customer Invoice</CardTitle>
        </span>
      </div>
      <p className="mt-2 text-sm text-gray-500">
        A read-only invoice page the customer can open without logging in. Links work for 30 days; creating or sending a new
        link stops the previous one.
      </p>

      <div className="mt-3 text-sm">
        {link ? (
          <div className="space-y-2">
            <input
              readOnly
              aria-label="Invoice link"
              value={link.invoiceUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-xs text-gray-700"
            />
            <p className="text-xs text-gray-400">Expires {dt(link.expiresAt)}</p>
          </div>
        ) : statusQ.isLoading ? (
          <p className="text-gray-400">Checking for an active link...</p>
        ) : active ? (
          <p className="text-gray-600">
            An invoice link is active (created {dt(active.createdAt)}, expires {dt(active.expiresAt)}). For security it cannot be
            shown again - create a new link to copy, open or print it.
          </p>
        ) : (
          <p className="text-gray-600">No active invoice link.</p>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <PermissionGate permissions={ROUTE_PERMISSIONS.orderUpdate}>
          <PanelButton icon={FileText} onClick={() => void create()}>{active || link ? 'Create new link' : 'Create invoice link'}</PanelButton>
        </PermissionGate>
        {link ? (
          <>
            <PanelButton icon={Copy} onClick={() => void copy()}>Copy link</PanelButton>
            <PanelButton icon={ExternalLink} onClick={() => openInvoice()}>Open invoice</PanelButton>
            <PanelButton icon={Printer} onClick={() => openInvoice(true)}>Print invoice</PanelButton>
          </>
        ) : null}
        <PermissionGate permissions={[...ROUTE_PERMISSIONS.orderUpdate, ...ROUTE_PERMISSIONS.notificationSend]}>
          <PanelButton icon={MessageCircle} onClick={() => void sendWhatsApp()} disabled={!recipientPhone}>
            Send via WhatsApp
          </PanelButton>
        </PermissionGate>
      </div>
      {!recipientPhone ? <p className="mt-2 text-xs text-red-600">This order has no WhatsApp number.</p> : null}
    </Card>
  );
}

function PanelButton({ children, icon: Icon, ...props }: { children: ReactNode; icon: typeof Copy } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className="inline-flex h-10 items-center gap-2 rounded-lg bg-white px-4 text-sm font-medium text-gray-700 ring-1 ring-gray-200 transition hover:bg-gray-50 disabled:opacity-50"
    >
      <Icon className="h-4 w-4" />
      {children}
    </button>
  );
}
