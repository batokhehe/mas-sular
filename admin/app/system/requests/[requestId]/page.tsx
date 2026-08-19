'use client';

import { ReactNode, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle, ChevronDown, Copy, Download, ExternalLink, X,
  ShieldCheck, ShoppingCart, CreditCard, Boxes, Truck, Mail, Cog, Server,
} from 'lucide-react';
import { AdminShell } from '@/components/layout/admin-shell';
import { Card, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchSystemRequest, RequestGroup, RequestTimelineEvent } from '@/lib/admin';
import {
  GROUP_BADGE, LEVEL_DOT, LEVEL_BADGE, segmentTimeline, eventStack, eventJson, expandState, statusTone,
} from '@/lib/system/request-explorer-view';

const GROUP_ICON: Record<RequestGroup, typeof Mail> = {
  AUTH: ShieldCheck, ORDER: ShoppingCart, PAYMENT: CreditCard, INVENTORY: Boxes,
  SHIPMENT: Truck, NOTIFICATION: Mail, WORKER: Cog, SYSTEM: Server,
};
const STATUS_TONE: Record<ReturnType<typeof statusTone>, string> = {
  ok: 'text-emerald-600', warn: 'text-amber-600', error: 'text-red-600', muted: 'text-gray-500',
};

const dt = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'medium' }) : '—');
const t = (iso: string) => new Date(iso).toLocaleTimeString('id-ID', { hour12: false });

export default function RequestDetailPage() {
  const params = useParams<{ requestId: string }>();
  const requestId = typeof params?.requestId === 'string' ? decodeURIComponent(params.requestId) : undefined;

  const query = useQuery({
    queryKey: ['system-request', requestId],
    queryFn: () => fetchSystemRequest(requestId as string),
    enabled: !!requestId,
    retry: false,
  });
  const d = query.data;

  const segments = useMemo(() => (d ? segmentTimeline(d.timeline) : []), [d]);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const isOpen = (i: number) => open[i] ?? true; // default expanded
  const [selected, setSelected] = useState<RequestTimelineEvent | null>(null);

  const copy = (text: string) => void navigator.clipboard?.writeText(text);

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.systemLogs}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Request Detail</h2>
          <p className="mt-1 flex items-center gap-2 font-mono text-sm text-gray-500">
            {requestId}
            <button onClick={() => requestId && copy(requestId)} title="Copy Request ID" className="text-gray-300 hover:text-gray-600"><Copy className="h-4 w-4" /></button>
          </p>
        </div>
        <Link href="/system/requests" className="text-sm font-medium text-[#465fff] hover:underline">← Back to Request Explorer</Link>
      </div>

      {query.isLoading ? (
        <DetailSkeleton />
      ) : query.isError || !d ? (
        <Card>
          <div className="flex flex-col items-center gap-3 p-10 text-center">
            <AlertTriangle className="h-6 w-6 text-red-500" />
            <p className="text-sm text-red-600">Unable to load this request (it may have been pruned by retention).</p>
            <Button onClick={() => void query.refetch()}>Retry</Button>
          </div>
        </Card>
      ) : (
        <div className="space-y-5">
          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Card>
              <p className="text-xs uppercase text-gray-400">Status</p>
              <p className={`mt-1 text-2xl font-semibold ${STATUS_TONE[statusTone(d.summary.statusCode)]}`}>{d.summary.statusCode ?? '—'}</p>
              <p className="mt-1 truncate font-mono text-xs text-gray-400" title={`${d.summary.method ?? ''} ${d.summary.path ?? ''}`}>{d.summary.method} {d.summary.path}</p>
            </Card>
            <Card>
              <p className="text-xs uppercase text-gray-400">Duration</p>
              <p className="mt-1 text-2xl font-semibold text-gray-900">{d.summary.durationMs}ms</p>
              <p className="mt-1 text-xs text-gray-400">{dt(d.summary.startedAt)} → {t(d.summary.finishedAt)}</p>
            </Card>
            <Card>
              <p className="text-xs uppercase text-gray-400">User</p>
              <p className="mt-1 truncate text-lg font-semibold text-gray-900">{d.summary.admin?.name ?? d.summary.user?.name ?? '—'}</p>
              <p className="mt-1 truncate text-xs text-gray-400">{d.summary.admin ? 'Admin' : d.summary.user?.email ?? '—'}</p>
            </Card>
            <Card>
              <p className="text-xs uppercase text-gray-400">IP · Client</p>
              <p className="mt-1 text-lg font-semibold text-gray-900">{d.summary.ip ?? '—'}</p>
              <p className="mt-1 text-xs text-gray-400">{d.summary.browser} · {d.summary.device}</p>
            </Card>
            <Card>
              <p className="text-xs uppercase text-gray-400">Logs</p>
              <p className="mt-1 text-2xl font-semibold text-gray-900">{d.summary.totalLogs}</p>
              <p className="mt-1 text-xs">
                <span className={d.summary.errorCount > 0 ? 'font-semibold text-red-600' : 'text-gray-400'}>{d.summary.errorCount} errors</span>
                <span className="text-gray-300"> · </span>
                <span className={d.summary.warningCount > 0 ? 'font-semibold text-amber-600' : 'text-gray-400'}>{d.summary.warningCount} warnings</span>
              </p>
            </Card>
          </div>

          {/* Related links */}
          {(d.related.orderId || d.related.paymentId || d.related.shipmentId || d.related.userId) ? (
            <Card>
              <CardTitle>Related</CardTitle>
              <div className="mt-3 flex flex-wrap gap-2">
                {d.related.orderId ? <RelatedLink href={`/orders/${d.related.orderId}`} label="Order" id={d.related.orderId} /> : null}
                {d.related.paymentId ? <RelatedLink href="/payments" label="Payment" id={d.related.paymentId} /> : null}
                {d.related.shipmentId ? <RelatedLink href={`/shipping/${d.related.shipmentId}`} label="Shipment" id={d.related.shipmentId} /> : null}
                {d.related.userId ? <RelatedLink href={`/users/${d.related.userId}`} label="Customer" id={d.related.userId} /> : null}
              </div>
            </Card>
          ) : null}

          {/* Timeline */}
          <Card>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <CardTitle>Timeline</CardTitle>
              <div className="flex gap-2 text-xs">
                <button onClick={() => setOpen(expandState(segments.length, true))} className="rounded-lg px-3 py-1.5 font-medium text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50">Expand All</button>
                <button onClick={() => setOpen(expandState(segments.length, false))} className="rounded-lg px-3 py-1.5 font-medium text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50">Collapse All</button>
              </div>
            </div>
            {segments.length === 0 ? (
              <p className="p-8 text-center text-sm text-gray-500">No timeline events for this request.</p>
            ) : (
              <div className="space-y-3">
                {segments.map((seg, i) => {
                  const Icon = GROUP_ICON[seg.group];
                  return (
                    <div key={i} className="rounded-xl border border-gray-100">
                      <button onClick={() => setOpen((o) => ({ ...o, [i]: !isOpen(i) }))} className="flex w-full items-center justify-between px-4 py-2.5">
                        <span className="flex items-center gap-2">
                          <Icon className="h-4 w-4 text-gray-400" />
                          <span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${GROUP_BADGE[seg.group]}`}>{seg.group}</span>
                          <span className="text-xs text-gray-400">{seg.events.length} event{seg.events.length > 1 ? 's' : ''}</span>
                        </span>
                        <ChevronDown className={`h-4 w-4 text-gray-300 transition ${isOpen(i) ? 'rotate-180' : ''}`} />
                      </button>
                      {isOpen(i) ? (
                        <ol className="relative ml-6 space-y-3 border-l border-gray-200 px-4 pb-4 pt-1">
                          {seg.events.map((e) => (
                            <li key={e.id} className="relative">
                              <span className={`absolute -left-[21.5px] top-1.5 h-2.5 w-2.5 rounded-full ${LEVEL_DOT[e.level]}`} />
                              <button onClick={() => setSelected(e)} className="w-full rounded-lg px-2 py-1 text-left hover:bg-gray-50">
                                <p className="flex flex-wrap items-center gap-2 text-sm">
                                  <span className="font-mono text-xs text-gray-400">{t(e.time)}</span>
                                  <span className="font-medium text-gray-800">{e.module}</span>
                                  <span className="text-gray-400">·</span>
                                  <span className="text-gray-600">{e.action}</span>
                                  {e.durationMs != null ? <span className="text-xs text-gray-400">{e.durationMs}ms</span> : null}
                                </p>
                                <p className="mt-0.5 truncate text-xs text-gray-500" title={e.message}>{e.message}</p>
                              </button>
                            </li>
                          ))}
                        </ol>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>
      )}

      {selected ? <EventDrawer event={selected} onClose={() => setSelected(null)} /> : null}
    </AdminShell>
  );
}

function RelatedLink({ href, label, id }: { href: string; label: string; id: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:border-[#465fff] hover:text-[#465fff]">
      <ExternalLink className="h-3.5 w-3.5" />
      {label} <span className="font-mono text-gray-400">{id.slice(0, 8)}…</span>
    </Link>
  );
}

function EventDrawer({ event, onClose }: { event: RequestTimelineEvent; onClose: () => void }) {
  const stack = eventStack(event);
  const json = eventJson(event);
  const copy = (text: string) => void navigator.clipboard?.writeText(text);
  const download = () => {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `event-${event.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />
      <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <h3 className="font-semibold text-gray-900">Event detail</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><X className="h-5 w-5" /></button>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto p-5 text-sm">
          <section>
            <p className="mb-2 text-xs font-semibold uppercase text-gray-400">General</p>
            <dl className="space-y-1.5">
              <Field label="Level" value={<span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${LEVEL_BADGE[event.level]}`}>{event.level}</span>} />
              <Field label="Time" value={dt(event.time)} />
              <Field label="Group" value={<span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${GROUP_BADGE[event.group]}`}>{event.group}</span>} />
              <Field label="Module" value={event.module} />
              <Field label="Action" value={event.action} />
              <Field label="Duration" value={event.durationMs != null ? `${event.durationMs}ms` : '—'} />
              <Field label="Status" value={event.statusCode ?? '—'} />
            </dl>
          </section>

          <section>
            <p className="mb-2 text-xs font-semibold uppercase text-gray-400">Message</p>
            <p className="whitespace-pre-wrap break-words rounded-lg bg-gray-50 p-3 text-gray-700">{event.message}</p>
          </section>

          {stack ? (
            <section>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-semibold uppercase text-gray-400">Stack Trace</p>
                <button onClick={() => copy(stack)} className="inline-flex items-center gap-1 text-xs font-medium text-[#465fff]"><Copy className="h-3.5 w-3.5" /> Copy Stack</button>
              </div>
              <pre className="max-h-64 overflow-auto rounded-lg bg-red-50 p-3 text-xs text-red-800">{stack}</pre>
            </section>
          ) : null}

          <section>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase text-gray-400">Metadata JSON</p>
              <span className="flex gap-3">
                <button onClick={() => copy(json)} className="inline-flex items-center gap-1 text-xs font-medium text-[#465fff]"><Copy className="h-3.5 w-3.5" /> Copy JSON</button>
                <button onClick={download} className="inline-flex items-center gap-1 text-xs font-medium text-[#465fff]"><Download className="h-3.5 w-3.5" /> Download JSON</button>
              </span>
            </div>
            <pre className="max-h-80 overflow-auto rounded-lg bg-gray-50 p-3 text-xs text-gray-700">{JSON.stringify(event.metadata ?? {}, null, 2)}</pre>
          </section>
        </div>
      </aside>
    </>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="shrink-0 text-gray-400">{label}</dt>
      <dd className="text-right font-medium text-gray-800">{value}</dd>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i} className="animate-pulse"><div className="h-3 w-1/2 rounded bg-gray-200" /><div className="mt-2 h-7 w-2/3 rounded bg-gray-200" /></Card>
        ))}
      </div>
      <Card className="h-72 animate-pulse"><div className="h-full w-full rounded bg-gray-100" /></Card>
    </div>
  );
}
