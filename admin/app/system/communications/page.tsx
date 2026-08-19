'use client';

import { FormEvent, ReactNode, Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  AlertTriangle, ChevronDown, ChevronRight, ClipboardList, CreditCard, ExternalLink, Eye, Inbox,
  MessagesSquare, Search, Send, Truck, User as UserIcon,
} from 'lucide-react';
import { AdminShell } from '@/components/layout/admin-shell';
import { PermissionGate } from '@/components/auth/permission-gate';
import { Card, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import {
  fetchCommunicationByCustomer, fetchCommunicationByNotification, previewCommunication, searchCommunicationCustomers,
  sendCommunication, CommunicationBundle, CommunicationCustomer, CommunicationPreview, ConversationItem, ManualSendTemplate,
} from '@/lib/admin';
import { CHANNEL_BADGE, deliveryLabel } from '@/lib/system/notification-view';
import {
  MANUAL_SEND_TEMPLATES, conversationGroups, deliveryTimeline, historyBadges, idr, templateLabel, DeliveryStep,
} from '@/lib/system/communication-view';
import { ADMIN_LOADING_MESSAGES, runWithFeedback } from '@/lib/admin-alert';

const dt = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' }) : '—');

const GROUP_ICON = { order: ClipboardList, payment: CreditCard, shipment: Truck, general: Inbox } as const;

export default function CustomerCommunicationsPage() {
  // useSearchParams requires a Suspense boundary for static prerendering.
  return (
    <Suspense fallback={null}>
      <CommunicationsInner />
    </Suspense>
  );
}

function CommunicationsInner() {
  const router = useRouter();
  const params = useSearchParams();
  const userId = params.get('user');
  const notificationId = params.get('notification');

  const bundleQuery = useQuery({
    queryKey: ['communication-bundle', userId ?? `n:${notificationId}`],
    queryFn: () => (userId ? fetchCommunicationByCustomer(userId) : fetchCommunicationByNotification(notificationId!)),
    enabled: !!userId || !!notificationId,
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
  });
  const bundle = bundleQuery.data;

  const selectCustomer = (c: CommunicationCustomer) => router.replace(`/system/communications?user=${c.id}`);

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.communications}>
      <div className="mb-6">
        <nav className="flex items-center gap-1 text-xs text-gray-400">
          System <ChevronRight className="h-3 w-3" /> <span className="font-medium text-gray-600">Customer Communications</span>
        </nav>
        <h2 className="mt-1 text-xl font-semibold text-gray-900">Customer Communication Center</h2>
        <p className="mt-1 text-sm text-gray-500">Every notification a customer received, grouped per order — plus manual sends through the same delivery pipeline.</p>
      </div>

      <CustomerSearch onSelect={selectCustomer} />

      {!userId && !notificationId ? (
        <Card className="mt-6">
          <div className="flex flex-col items-center gap-2 p-10 text-center text-sm text-gray-500">
            <MessagesSquare className="h-6 w-6 text-gray-300" />
            Search for a customer by name, phone, email, order number, or notification ID to open their conversation.
          </div>
        </Card>
      ) : bundleQuery.isLoading ? (
        <Card className="mt-6 h-72 animate-pulse"><div className="h-full w-full rounded bg-gray-100" /></Card>
      ) : bundleQuery.isError || !bundle ? (
        <Card className="mt-6">
          <div className="flex flex-col items-center gap-3 p-10 text-center">
            <AlertTriangle className="h-6 w-6 text-red-500" />
            <p className="text-sm text-red-600">Unable to load the conversation.</p>
            <Button onClick={() => void bundleQuery.refetch()}>Retry</Button>
          </div>
        </Card>
      ) : (
        <div className="mt-6 grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <ConversationPanel bundle={bundle} />
          <div className="space-y-6">
            <ProfilePanel bundle={bundle} />
            <MetricsPanel bundle={bundle} />
            <PermissionGate permissions={ROUTE_PERMISSIONS.notificationSend}>
              <ManualSendPanel customer={bundle.customer} onSent={() => void bundleQuery.refetch()} />
            </PermissionGate>
          </div>
        </div>
      )}
    </AdminShell>
  );
}

// ---------------- Search ----------------

function CustomerSearch({ onSelect }: { onSelect: (c: CommunicationCustomer) => void }) {
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(term.trim()), 350);
    return () => window.clearTimeout(t);
  }, [term]);

  const search = useQuery({
    queryKey: ['communication-search', debounced],
    queryFn: () => searchCommunicationCustomers(debounced),
    enabled: debounced.length >= 2,
    staleTime: 30_000,
    retry: false,
  });
  const results = debounced.length >= 2 ? (search.data?.customers ?? []) : [];

  return (
    <Card>
      <label className="flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 px-3 focus-within:border-[#465fff] focus-within:bg-white">
        <Search className="h-4 w-4 shrink-0 text-gray-400" />
        <input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search customer, phone, email, order number, or notification ID…"
          className="h-11 w-full bg-transparent text-sm outline-none"
        />
      </label>
      {debounced.length >= 2 ? (
        search.isLoading ? (
          <p className="mt-3 text-xs text-gray-400">Searching…</p>
        ) : results.length === 0 ? (
          <p className="mt-3 text-xs text-gray-400">No matching customers.</p>
        ) : (
          <ul className="mt-3 divide-y divide-gray-50">
            {results.map((c) => (
              <li key={c.id}>
                <button onClick={() => onSelect(c)} className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2 text-left hover:bg-gray-50">
                  <span className="flex items-center gap-2 text-sm">
                    <UserIcon className="h-4 w-4 text-gray-300" />
                    <span className="font-medium text-gray-800">{c.name}</span>
                    <span className="text-xs text-gray-400">{c.email}{c.phone ? ` · ${c.phone}` : ''}</span>
                  </span>
                  <span className="text-[11px] uppercase text-gray-300">via {c.via}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </Card>
  );
}

// ---------------- Conversation (left column) ----------------

function ConversationPanel({ bundle }: { bundle: CommunicationBundle }) {
  const groups = useMemo(() => conversationGroups(bundle.conversation), [bundle.conversation]);
  return (
    <Card>
      <CardTitle>Conversation</CardTitle>
      <p className="mt-1 text-xs text-gray-400">
        {bundle.conversation.length} notification(s){bundle.customer ? ` for ${bundle.customer.name}` : bundle.anchorRecipient ? ` to ${bundle.anchorRecipient}` : ''} — oldest first.
      </p>
      {groups.length === 0 ? (
        <p className="p-10 text-center text-sm text-gray-500">No notifications for this customer yet.</p>
      ) : (
        <div className="mt-4 space-y-6">
          {groups.map((g) => {
            const Icon = GROUP_ICON[g.kind];
            const href =
              g.kind === 'order' && g.items[0].related.orderId
                ? `/orders/${g.items[0].related.orderId}`
                : g.kind === 'shipment' && g.items[0].related.shipmentId
                  ? `/shipping/${g.items[0].related.shipmentId}`
                  : g.kind === 'payment'
                    ? '/payments'
                    : null;
            return (
              <section key={g.key}>
                <div className="mb-2 flex items-center gap-2">
                  <Icon className="h-4 w-4 text-gray-400" />
                  <h3 className="text-sm font-semibold text-gray-800">{g.label}</h3>
                  {href ? (
                    <Link href={href} className="inline-flex items-center gap-1 text-xs font-medium text-[#465fff]">
                      <ExternalLink className="h-3 w-3" /> open
                    </Link>
                  ) : null}
                </div>
                <ol className="ml-1.5 border-l border-gray-100 pl-4">
                  {g.items.map((n) => <ConversationEvent key={n.id} n={n} />)}
                </ol>
              </section>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function ConversationEvent({ n }: { n: ConversationItem }) {
  const [open, setOpen] = useState(false);
  const dotTone = n.status === 'SENT' ? 'bg-emerald-500' : n.status === 'FAILED' ? 'bg-red-500' : 'bg-amber-400';
  return (
    <li className="relative pb-4 last:pb-0">
      <span className={`absolute -left-[21.5px] top-1.5 h-[11px] w-[11px] rounded-full ${dotTone}`} />
      <button onClick={() => setOpen((v) => !v)} className="w-full text-left">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-gray-800">{templateLabel(n)}</span>
          <Badge cls={CHANNEL_BADGE[n.channel] ?? 'bg-gray-100 text-gray-600'}>{n.channel}</Badge>
          {historyBadges(n).map((b) => <Badge key={b.label} cls={b.cls}>{b.label}</Badge>)}
          <ChevronDown className={`h-3.5 w-3.5 text-gray-300 transition-transform ${open ? 'rotate-180' : ''}`} />
        </div>
        <p className="mt-0.5 text-xs text-gray-400">
          {dt(n.createdAt)} · {n.recipient || '—'} · {deliveryLabel(n.deliverySec)}
        </p>
      </button>
      {open ? (
        <div className="mt-2 rounded-xl border border-gray-100 bg-gray-50/60 p-3">
          {n.subject ? <p className="mb-2 text-xs text-gray-600"><span className="text-gray-400">Subject:</span> {n.subject}</p> : null}
          <DeliveryTracking steps={deliveryTimeline(n)} />
          <p className="mt-2 font-mono text-[10px] text-gray-300">{n.id}</p>
        </div>
      ) : null}
    </li>
  );
}

function DeliveryTracking({ steps }: { steps: DeliveryStep[] }) {
  const dot: Record<DeliveryStep['tone'], string> = { ok: 'bg-emerald-500', error: 'bg-red-500', pending: 'bg-amber-400' };
  return (
    <ol>
      {steps.map((s, i) => (
        <li key={`${s.label}-${i}`} className="relative flex gap-2.5 pb-3 last:pb-0">
          {i < steps.length - 1 ? <span className="absolute left-[4px] top-3.5 h-full w-px bg-gray-200" aria-hidden /> : null}
          <span className={`relative mt-1 h-[9px] w-[9px] shrink-0 rounded-full ${dot[s.tone]}`} />
          <div className="min-w-0">
            <p className={`text-xs font-medium ${s.tone === 'error' ? 'text-red-700' : 'text-gray-700'}`}>
              {s.label}{s.at ? <span className="ml-2 font-normal text-gray-400">{dt(s.at)}</span> : null}
            </p>
            {s.detail ? <p className="break-all text-[11px] text-gray-500">{s.detail}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

// ---------------- Right column ----------------

function ProfilePanel({ bundle }: { bundle: CommunicationBundle }) {
  const c = bundle.customer;
  const p = bundle.profile;
  return (
    <Card>
      <CardTitle>Customer Profile</CardTitle>
      {!c ? (
        <p className="mt-3 text-sm text-gray-500">
          No registered customer matched{bundle.anchorRecipient ? ` recipient ${bundle.anchorRecipient}` : ''} (guest or outdated contact).
        </p>
      ) : (
        <dl className="mt-3 space-y-1.5 text-sm">
          <Field label="Customer" value={c.name} href={`/users/${c.id}`} />
          <Field label="Phone" value={c.phone ?? '—'} />
          <Field label="Email" value={c.email} />
          <Field label="Total Orders" value={String(p?.totalOrders ?? 0)} />
          <Field label="Completed Orders" value={String(p?.completedOrders ?? 0)} />
          <Field label="Cancelled Orders" value={String(p?.cancelledOrders ?? 0)} />
          <Field label="Last Order" value={dt(p?.lastOrderAt)} />
          <Field label="Lifetime Value" value={idr(p?.lifetimeValue ?? 0)} />
          <Field label="Last Notification" value={dt(bundle.metrics.lastNotificationAt)} />
        </dl>
      )}
    </Card>
  );
}

function MetricsPanel({ bundle }: { bundle: CommunicationBundle }) {
  const m = bundle.metrics;
  return (
    <Card>
      <CardTitle>Notification Metrics</CardTitle>
      <dl className="mt-3 space-y-1.5 text-sm">
        <Field label="Notifications Sent" value={String(m.sent)} />
        <Field label="Failed" value={String(m.failed)} />
        <Field label="Queued" value={String(m.pending)} />
        <Field label="Success Rate" value={m.successRatePct != null ? `${m.successRatePct}%` : '—'} />
        <Field label="Avg Delivery" value={m.avgDeliverySec != null ? deliveryLabel(m.avgDeliverySec) : '—'} />
        <Field label="Last Notification" value={dt(m.lastNotificationAt)} />
      </dl>
    </Card>
  );
}

// ---------------- Manual send (Notification.send) ----------------

function ManualSendPanel({ customer, onSent }: { customer: CommunicationCustomer | null; onSent: () => void }) {
  const [channel, setChannel] = useState<'WHATSAPP' | 'EMAIL'>('WHATSAPP');
  const [template, setTemplate] = useState<ManualSendTemplate>('manual.order-update');
  const [recipient, setRecipient] = useState('');
  const [orderNumber, setOrderNumber] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState<CommunicationPreview | null>(null);

  const tpl = MANUAL_SEND_TEMPLATES.find((t) => t.value === template)!;

  // Prefill the recipient from the selected customer whenever customer/channel changes.
  useEffect(() => {
    setRecipient(channel === 'EMAIL' ? (customer?.email ?? '') : (customer?.phone ?? ''));
  }, [customer, channel]);
  useEffect(() => setPreview(null), [channel, template, message, orderNumber, subject]);

  const previewM = useMutation({ mutationFn: previewCommunication, onSuccess: setPreview });
  const sendM = useMutation({ mutationFn: sendCommunication });

  const body = {
    channel,
    template,
    message: message.trim(),
    customerName: customer?.name,
    ...(tpl.needsOrderNumber && orderNumber.trim() ? { orderNumber: orderNumber.trim() } : {}),
    ...(tpl.needsSubject && subject.trim() ? { subject: subject.trim() } : {}),
  };
  const canSubmit = message.trim().length > 0 && recipient.trim().length >= 3 && !sendM.isPending;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    void runWithFeedback({
      loading: ADMIN_LOADING_MESSAGES.update,
      success: 'Message queued — the sender worker will deliver it',
      action: async () => {
        await sendM.mutateAsync({ ...body, recipient: recipient.trim(), customerId: customer?.id });
        setMessage('');
        setPreview(null);
        onSent();
      },
    });
  };

  return (
    <Card>
      <CardTitle>Manual Send</CardTitle>
      <p className="mt-1 text-xs text-gray-400">Queued through the notification outbox — delivered by the existing sender worker.</p>
      <form onSubmit={submit} className="mt-3 space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="block text-xs uppercase text-gray-400">Channel</span>
            <select value={channel} onChange={(e) => setChannel(e.target.value as 'WHATSAPP' | 'EMAIL')} className="h-10 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]">
              <option value="WHATSAPP">WhatsApp</option>
              <option value="EMAIL">Email</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-xs uppercase text-gray-400">Template</span>
            <select value={template} onChange={(e) => setTemplate(e.target.value as ManualSendTemplate)} className="h-10 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]">
              {MANUAL_SEND_TEMPLATES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </label>
        </div>
        <label className="block space-y-1">
          <span className="block text-xs uppercase text-gray-400">Recipient ({channel === 'EMAIL' ? 'email' : 'phone'})</span>
          <input value={recipient} onChange={(e) => setRecipient(e.target.value)} className="h-10 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]" placeholder={channel === 'EMAIL' ? 'customer@mail.com' : '628…'} />
        </label>
        {tpl.needsOrderNumber ? (
          <label className="block space-y-1">
            <span className="block text-xs uppercase text-gray-400">Order Number</span>
            <input value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} className="h-10 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]" placeholder="BMS-…" />
          </label>
        ) : null}
        {tpl.needsSubject ? (
          <label className="block space-y-1">
            <span className="block text-xs uppercase text-gray-400">Subject (email)</span>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} className="h-10 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]" />
          </label>
        ) : null}
        <label className="block space-y-1">
          <span className="block text-xs uppercase text-gray-400">Message</span>
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={4} maxLength={1000} className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#465fff]" placeholder="Tulis pesan untuk pelanggan…" />
        </label>

        {preview ? (
          <div className="rounded-xl border border-gray-100 bg-gray-50/60 p-3">
            <p className="text-[11px] uppercase text-gray-400">Preview — variables: {preview.variables.join(', ')}</p>
            <p className="mt-1 text-xs font-semibold text-gray-800">{preview.rendered.subject}</p>
            <pre className="mt-1 whitespace-pre-wrap text-xs text-gray-600">{preview.rendered.body}</pre>
            {!preview.channels[channel] ? (
              <p className="mt-2 text-xs font-medium text-amber-600">This channel is not configured for manual sends — the send will be rejected.</p>
            ) : null}
          </div>
        ) : null}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => previewM.mutate(body)}
            disabled={message.trim().length === 0 || previewM.isPending}
            className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:border-[#465fff] hover:text-[#465fff] disabled:opacity-50"
          >
            <Eye className="h-4 w-4" /> Preview
          </button>
          <Button type="submit" disabled={!canSubmit} className="flex-1 gap-2">
            <Send className="h-4 w-4" /> Send
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ---------------- Small shared bits ----------------

function Badge({ cls, children }: { cls: string; children: ReactNode }) {
  return <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-semibold ${cls}`}>{children}</span>;
}

function Field({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="shrink-0 text-gray-400">{label}</dt>
      <dd className="break-all text-right font-medium text-gray-800">
        {href ? <Link href={href} className="text-[#465fff] hover:underline">{value}</Link> : value}
      </dd>
    </div>
  );
}
