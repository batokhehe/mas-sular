'use client';

import { PointerEvent as ReactPointerEvent, ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Check, Copy, Download, ExternalLink, GripVertical, Send, X } from 'lucide-react';
import { PermissionGate } from '@/components/auth/permission-gate';
import { Button } from '@/components/ui/button';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchCommunicationByNotification, fetchNotificationDetail } from '@/lib/admin';
import { historyBadges, templateLabel } from '@/lib/system/communication-view';
import {
  CHANNEL_BADGE, NOTIF_STATUS_BADGE, buildTimeline, canResend, clampDrawerWidth, deliveryLabel, providerOf,
  DRAWER_DEFAULT_WIDTH, DRAWER_WIDTH_STORAGE_KEY, TimelineStep,
} from '@/lib/system/notification-view';
import { relatedLinks } from '@/lib/system/queue-center-view';

const dt = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'medium' }) : '—');

/**
 * Notification inspector drawer. Lazy-loaded (next/dynamic) from the list page so
 * its code is only fetched when a row is opened. Read-only apart from Resend.
 */
export default function NotificationDrawer({ id, onClose, onResend }: { id: string; onClose: () => void; onResend: (id: string) => void }) {
  const detail = useQuery({ queryKey: ['notification-detail', id], queryFn: () => fetchNotificationDetail(id), retry: false });
  const d = detail.data;
  const n = d?.notification;
  const payloadJson = JSON.stringify(n?.payload ?? {}, null, 2);
  const responseJson = JSON.stringify(d?.providerResponse ?? {}, null, 2);
  const download = () => {
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `notification-${id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const links = d ? relatedLinks(d.related) : [];
  const { width, dragProps } = useDrawerWidth();

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />
      <aside className="fixed inset-y-0 right-0 z-50 flex w-full flex-col bg-white shadow-2xl" style={{ maxWidth: width }} role="dialog" aria-label="Notification detail">
        {/* Resize handle (desktop) — drag to adjust, persisted across sessions. */}
        <div
          {...dragProps}
          className="absolute inset-y-0 left-0 hidden w-2 cursor-col-resize items-center justify-center hover:bg-gray-100 sm:flex"
          title="Drag to resize"
        >
          <GripVertical className="h-4 w-4 text-gray-300" />
        </div>
        <div className="flex items-center justify-between border-b border-gray-100 py-4 pl-5 pr-5">
          <div>
            <h3 className="font-semibold text-gray-900">Notification detail</h3>
            {n ? <p className="mt-0.5 font-mono text-[11px] text-gray-400">{n.id}</p> : null}
          </div>
          <div className="flex items-center gap-3">
            {d ? (
              <button onClick={download} className="inline-flex items-center gap-1 text-xs font-medium text-[#465fff]">
                <Download className="h-3.5 w-3.5" /> Download JSON
              </button>
            ) : null}
            <button onClick={onClose} className="text-gray-400 hover:text-gray-700" aria-label="Close"><X className="h-5 w-5" /></button>
          </div>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto p-5 text-sm">
          {detail.isLoading || !d || !n ? (
            <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-4 w-full animate-pulse rounded bg-gray-100" />)}</div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge cls={CHANNEL_BADGE[n.channel] ?? 'bg-gray-100 text-gray-600'}>{n.channel}</Badge>
                <Badge cls={NOTIF_STATUS_BADGE[n.status]}>{n.status}</Badge>
                <span className="text-xs text-gray-400">{n.template}</span>
              </div>

              {canResend(n.status) ? (
                <PermissionGate permissions={ROUTE_PERMISSIONS.notificationResend}>
                  <Button onClick={() => onResend(n.id)} className="w-full gap-2"><Send className="h-4 w-4" /> Resend (re-queue via redrive)</Button>
                </PermissionGate>
              ) : null}

              <InspectorCard title="General">
                <dl className="space-y-1.5">
                  <Field label="ID" value={n.id} mono copyable />
                  <Field label="Channel" value={n.channel} />
                  <Field label="Status" value={n.status} />
                  <Field label="Template" value={n.template} mono />
                  <Field label="Recipient" value={n.recipient || '—'} copyable={!!n.recipient} />
                  <Field label="Subject" value={d.rendered?.subject ?? '—'} />
                  <Field label="Created" value={dt(n.createdAt)} />
                  <Field label="Sent" value={dt(n.sentAt)} />
                  <Field label="Duration" value={deliveryLabel(n.deliverySec)} />
                </dl>
              </InspectorCard>

              <InspectorCard title="Timeline">
                <Timeline steps={buildTimeline(n)} />
              </InspectorCard>

              <InspectorCard title="Payload" action={<CopyButton text={payloadJson} label="Copy" />}>
                <pre className="max-h-64 overflow-auto rounded-lg bg-gray-50 p-3 text-xs text-gray-700">{payloadJson}</pre>
              </InspectorCard>

              <InspectorCard title="Provider" action={<CopyButton text={responseJson} label="Copy response" />}>
                <dl className="space-y-1.5">
                  <Field label="Provider" value={providerOf(n.channel)} />
                  <Field label="Provider Message ID" value={n.providerMessageId ?? '—'} mono copyable={!!n.providerMessageId} />
                  <Field label="Error" value={d.retryHistory.lastError ?? '—'} tone={d.retryHistory.lastError ? 'error' : undefined} />
                  <Field label="Retry Count" value={String(Math.max(0, d.retryHistory.attempts - 1))} />
                  <Field label="Next Retry" value={n.status === 'PENDING' ? dt(d.retryHistory.nextAttemptAt) : '—'} />
                  <Field label="Locked by" value={d.retryHistory.lockedBy ?? '—'} mono={!!d.retryHistory.lockedBy} />
                </dl>
              </InspectorCard>

              <InspectorCard title="Related Resources">
                {links.length === 0 ? (
                  <p className="text-xs text-gray-400">No related order, payment, shipment, or customer.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {links.map((l) => (
                      <Link key={l.label} href={l.href} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:border-[#465fff] hover:text-[#465fff]">
                        <ExternalLink className="h-3.5 w-3.5" /> {l.label} <span className="font-mono text-gray-400">{l.id.length > 12 ? `${l.id.slice(0, 8)}…` : l.id}</span>
                      </Link>
                    ))}
                  </div>
                )}
              </InspectorCard>

              {d.rendered ? (
                <InspectorCard title="Rendered Message">
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-xs text-gray-700">{d.rendered.body}</pre>
                </InspectorCard>
              ) : null}

              <ConversationCard notificationId={n.id} />
            </>
          )}
        </div>
      </aside>
    </>
  );
}

/** Persisted, clamped drawer width + pointer-drag wiring for the resize handle. */
function useDrawerWidth() {
  const [width, setWidth] = useState(DRAWER_DEFAULT_WIDTH);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    try {
      const stored = Number(window.localStorage.getItem(DRAWER_WIDTH_STORAGE_KEY));
      if (stored) setWidth(clampDrawerWidth(stored));
    } catch {
      // storage unavailable → default width
    }
  }, []);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = { startX: e.clientX, startWidth: width };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }, [width]);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setWidth(clampDrawerWidth(drag.current.startWidth + (drag.current.startX - e.clientX)));
  }, []);

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setWidth((w) => {
      try {
        window.localStorage.setItem(DRAWER_WIDTH_STORAGE_KEY, String(w));
      } catch {
        // best-effort persistence
      }
      return w;
    });
  }, []);

  return { width, dragProps: { onPointerDown, onPointerMove, onPointerUp } };
}

/** Compact customer conversation: every notification for the same customer. */
function ConversationCard({ notificationId }: { notificationId: string }) {
  const query = useQuery({
    queryKey: ['communication-bundle', `n:${notificationId}`],
    queryFn: () => fetchCommunicationByNotification(notificationId),
    staleTime: 30_000,
    retry: false,
  });
  const bundle = query.data;
  const items = bundle?.conversation ?? [];
  const recent = items.slice(-8);
  return (
    <InspectorCard
      title="Customer Conversation"
      action={
        <Link href={`/system/communications?notification=${notificationId}`} className="inline-flex items-center gap-1 text-xs font-medium text-[#465fff]">
          <ExternalLink className="h-3.5 w-3.5" /> Open full view
        </Link>
      }
    >
      {query.isLoading ? (
        <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-4 w-full animate-pulse rounded bg-gray-100" />)}</div>
      ) : query.isError || !bundle ? (
        <p className="text-xs text-gray-400">Conversation unavailable.</p>
      ) : (
        <>
          <p className="mb-2 text-xs text-gray-400">
            {bundle.customer ? `${bundle.customer.name} — ` : ''}{items.length} notification(s){items.length > recent.length ? `, showing last ${recent.length}` : ''}
          </p>
          <ul className="space-y-2">
            {recent.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2 text-xs">
                <span className={`h-2 w-2 shrink-0 rounded-full ${c.status === 'SENT' ? 'bg-emerald-500' : c.status === 'FAILED' ? 'bg-red-500' : 'bg-amber-400'}`} />
                <span className={`font-medium ${c.id === notificationId ? 'text-[#465fff]' : 'text-gray-700'}`}>{templateLabel(c)}</span>
                {historyBadges(c).slice(1).map((b) => <span key={b.label} className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${b.cls}`}>{b.label}</span>)}
                <span className="ml-auto text-gray-400">{dt(c.createdAt)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </InspectorCard>
  );
}

function Timeline({ steps }: { steps: TimelineStep[] }) {
  const dot: Record<TimelineStep['tone'], string> = {
    ok: 'bg-emerald-500',
    error: 'bg-red-500',
    pending: 'bg-amber-400',
  };
  return (
    <ol className="space-y-0">
      {steps.map((s, i) => (
        <li key={`${s.label}-${i}`} className="relative flex gap-3 pb-4 last:pb-0">
          {i < steps.length - 1 ? <span className="absolute left-[5px] top-4 h-full w-px bg-gray-200" aria-hidden /> : null}
          <span className={`relative mt-1 h-[11px] w-[11px] shrink-0 rounded-full ${dot[s.tone]}`} />
          <div className="min-w-0">
            <p className={`text-sm font-medium ${s.tone === 'error' ? 'text-red-700' : 'text-gray-800'}`}>{s.label}</p>
            {s.at ? <p className="text-xs text-gray-400">{dt(s.at)}</p> : null}
            {s.detail ? <p className="mt-0.5 break-all text-xs text-gray-500">{s.detail}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function InspectorCard({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-gray-100 p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs font-semibold uppercase text-gray-400">{title}</p>
        {action}
      </div>
      {children}
    </section>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button onClick={copy} className="inline-flex items-center gap-1 text-xs font-medium text-[#465fff]">
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? 'Copied' : label}
    </button>
  );
}

function Badge({ cls, children }: { cls: string; children: ReactNode }) {
  return <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-semibold ${cls}`}>{children}</span>;
}

function Field({ label, value, mono, copyable, tone }: { label: string; value: string; mono?: boolean; copyable?: boolean; tone?: 'error' }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="shrink-0 text-gray-400">{label}</dt>
      <dd className={`flex min-w-0 items-start justify-end gap-1.5 break-all text-right font-medium ${tone === 'error' ? 'text-red-600' : 'text-gray-800'} ${mono ? 'font-mono text-xs leading-5' : ''}`}>
        {value}
        {copyable && value !== '—' ? (
          <button onClick={() => void navigator.clipboard?.writeText(value)} className="mt-0.5 shrink-0 text-gray-300 hover:text-[#465fff]" title={`Copy ${label}`}>
            <Copy className="h-3 w-3" />
          </button>
        ) : null}
      </dd>
    </div>
  );
}
