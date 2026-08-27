'use client';

import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronLeft, ChevronRight, Copy, Download, ExternalLink, FileDown, RefreshCw, X } from 'lucide-react';
import { AdminShell } from '@/components/layout/admin-shell';
import { PermissionGate } from '@/components/auth/permission-gate';
import { Card, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/ui/pagination';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchAuditTrail, fetchAuditEntry, exportAuditCsv, AuditFilters } from '@/lib/admin';
import {
  actionBadge, entityHref, entrySummary, diffRows, AUDIT_FILTER_KEY, serializeFilters, parseFilters, csvFilename,
} from '@/lib/system/audit-view';
import { runWithFeedback } from '@/lib/admin-alert';
import { formatNumberID } from '@/lib/utils/number';

const dt = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'medium' }) : '—');
const rp = formatNumberID;

export default function AuditTrailPage() {
  // Remembered filters (restored from localStorage on mount).
  const [filters, setFilters] = useState<AuditFilters>({});
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setFilters(parseFilters(typeof window !== 'undefined' ? window.localStorage.getItem(AUDIT_FILTER_KEY) : null));
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (hydrated && typeof window !== 'undefined') window.localStorage.setItem(AUDIT_FILTER_KEY, serializeFilters(filters));
  }, [filters, hydrated]);

  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const patch = (p: Partial<AuditFilters>) => {
    setFilters((f) => ({ ...f, ...p }));
    setPage(1);
  };

  const query = useQuery({
    queryKey: ['audit-trail', filters, page, limit],
    queryFn: () => fetchAuditTrail({ ...filters, page, limit }),
    placeholderData: keepPreviousData,
    enabled: hydrated,
    staleTime: 15_000,
    retry: false,
  });
  const data = query.data;

  const exportCsv = () =>
    runWithFeedback({
      loading: 'Preparing CSV…',
      success: 'Audit CSV downloaded',
      action: async () => {
        const blob = await exportAuditCsv(filters);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = csvFilename();
        a.click();
        URL.revokeObjectURL(url);
      },
    });

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.audit}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <nav className="flex items-center gap-1 text-xs text-gray-400">
            System <ChevronRight className="h-3 w-3" /> <span className="font-medium text-gray-600">Audit Trail</span>
          </nav>
          <h2 className="mt-1 text-xl font-semibold text-gray-900">Audit Trail</h2>
          <p className="mt-1 text-sm text-gray-500">Every administrative action — who changed what, when, and how.</p>
        </div>
        <div className="flex gap-2">
          <PermissionGate permissions={ROUTE_PERMISSIONS.auditExport}>
            <Button onClick={() => void exportCsv()} className="gap-2 bg-white text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50">
              <FileDown className="h-4 w-4" /> Export CSV
            </Button>
          </PermissionGate>
          <Button onClick={() => void query.refetch()} disabled={query.isFetching} className="gap-2">
            <RefreshCw className={`h-4 w-4 ${query.isFetching ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        </div>
      </div>

      {query.isLoading || !hydrated ? (
        <Skeleton />
      ) : query.isError || !data ? (
        <Card>
          <div className="flex flex-col items-center gap-3 p-10 text-center">
            <AlertTriangle className="h-6 w-6 text-red-500" />
            <p className="text-sm text-red-600">Unable to load the audit trail.</p>
            <Button onClick={() => void query.refetch()}>Retry</Button>
          </div>
        </Card>
      ) : (
        <div className="space-y-6">
          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Today's Changes" value={rp(data.summary.todayChanges)} />
            <Stat label="Successful" value={rp(data.summary.successful)} tone="ok" />
            <Stat label="Failed" value={rp(data.summary.failed)} tone={data.summary.failed > 0 ? 'error' : undefined} />
            <Stat label="Unique Admins" value={rp(data.summary.uniqueAdmins)} />
          </div>

          <Card>
            {/* Sticky filters */}
            <div className="sticky top-0 z-10 -mx-5 -mt-5 flex flex-wrap items-end gap-3 rounded-t-2xl border-b border-gray-100 bg-white/95 px-5 pb-4 pt-5 backdrop-blur">
              <Filter label="Search"><input value={filters.search ?? ''} onChange={(e) => patch({ search: e.target.value || undefined })} placeholder="Entity, admin, request ID…" className="h-10 w-64 rounded-xl border border-gray-200 bg-gray-50 px-3 text-sm outline-none focus:border-[#465fff] focus:bg-white" /></Filter>
              <Filter label="Module"><input value={filters.module ?? ''} onChange={(e) => patch({ module: e.target.value || undefined })} placeholder="payments" className="h-10 w-32 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]" /></Filter>
              <Filter label="Action"><input value={filters.action ?? ''} onChange={(e) => patch({ action: e.target.value.toUpperCase() || undefined })} placeholder="VERIFY_PAYMENT" className="h-10 w-44 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]" /></Filter>
              <Filter label="Admin"><input value={filters.admin ?? ''} onChange={(e) => patch({ admin: e.target.value || undefined })} placeholder="name / id" className="h-10 w-36 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]" /></Filter>
              <Filter label="Status">
                <select value={filters.success ?? ''} onChange={(e) => patch({ success: e.target.value as AuditFilters['success'] })} className="h-10 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]">
                  <option value="">All</option><option value="true">Success</option><option value="false">Failed</option>
                </select>
              </Filter>
              <Filter label="From"><input type="datetime-local" onChange={(e) => patch({ dateFrom: e.target.value ? new Date(e.target.value).toISOString() : undefined })} className="h-10 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]" /></Filter>
              <Filter label="To"><input type="datetime-local" onChange={(e) => patch({ dateTo: e.target.value ? new Date(e.target.value).toISOString() : undefined })} className="h-10 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]" /></Filter>
              <button onClick={() => { setFilters({}); setPage(1); }} className="h-10 rounded-xl px-3 text-xs font-medium text-gray-500 hover:text-gray-800">Clear</button>
            </div>

            <div className="mt-4 overflow-x-auto">
              {(data.items.length ?? 0) === 0 ? (
                <p className="p-10 text-center text-sm text-gray-500">No audit entries found.</p>
              ) : (
                <table className="w-full min-w-[1000px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                      <th className="py-2 font-medium">Time</th><th className="py-2 font-medium">Admin</th><th className="py-2 font-medium">Module</th>
                      <th className="py-2 font-medium">Entity</th><th className="py-2 font-medium">Action</th><th className="py-2 font-medium">Status</th><th className="py-2 font-medium">Summary</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((e) => (
                      <tr key={e.id} onClick={() => setSelectedId(e.id)} className="cursor-pointer border-b border-gray-50 last:border-0 hover:bg-gray-50/70">
                        <td className="whitespace-nowrap py-2.5 text-gray-500">{dt(e.createdAt)}</td>
                        <td className="py-2.5 font-medium text-gray-800">{e.adminName ?? e.adminId ?? 'system'}</td>
                        <td className="py-2.5 text-gray-500">{e.module}</td>
                        <td className="py-2.5 text-gray-600">{e.entity}{e.entityName ? <span className="text-gray-400"> · {e.entityName}</span> : null}</td>
                        <td className="py-2.5"><Badge cls={actionBadge(e.action)}>{e.action}</Badge></td>
                        <td className="py-2.5"><Badge cls={e.success ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}>{e.success ? 'success' : 'failed'}</Badge></td>
                        <td className="max-w-[220px] truncate py-2.5 text-gray-500">{entrySummary(e)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            {data.total > 0 ? (
              <Pagination page={data.page} limit={data.limit} total={data.total} totalPages={data.totalPages} onPageChange={setPage} onLimitChange={(l) => { setLimit(l); setPage(1); }} />
            ) : null}
          </Card>
        </div>
      )}

      {selectedId ? <AuditDrawer id={selectedId} onClose={() => setSelectedId(null)} onNavigate={setSelectedId} /> : null}
    </AdminShell>
  );
}

function AuditDrawer({ id, onClose, onNavigate }: { id: string; onClose: () => void; onNavigate: (id: string) => void }) {
  const detail = useQuery({ queryKey: ['audit-entry', id], queryFn: () => fetchAuditEntry(id), retry: false });
  const d = detail.data;
  const e = d?.entry;

  // Resizable drawer: drag the left edge.
  const [width, setWidth] = useState(560);
  const dragging = useRef(false);
  const onPointerMove = useCallback((ev: PointerEvent) => {
    if (dragging.current) setWidth(Math.min(Math.max(window.innerWidth - ev.clientX, 420), Math.min(980, window.innerWidth - 80)));
  }, []);
  useEffect(() => {
    const stop = () => { dragging.current = false; };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stop);
    return () => { window.removeEventListener('pointermove', onPointerMove); window.removeEventListener('pointerup', stop); };
  }, [onPointerMove]);

  const copy = (text: string) => void navigator.clipboard?.writeText(text);
  const rawJson = JSON.stringify(e ?? {}, null, 2);
  const download = () => {
    const blob = new Blob([rawJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-${id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const link = e ? entityHref(e.entity, e.entityId) : null;
  const rows = e ? diffRows(e.diff) : [];

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />
      <aside className="fixed inset-y-0 right-0 z-50 flex flex-col bg-white shadow-2xl" style={{ width }}>
        <div onPointerDown={() => { dragging.current = true; }} className="absolute inset-y-0 left-0 w-1.5 cursor-col-resize bg-transparent hover:bg-[#465fff]/30" title="Drag to resize" />
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <h3 className="font-semibold text-gray-900">Audit entry</h3>
          <span className="flex items-center gap-2">
            <button disabled={!d?.previous} onClick={() => d?.previous && onNavigate(d.previous.id)} title="Previous entry for this entity" className="rounded-lg p-1.5 text-gray-400 ring-1 ring-gray-200 hover:text-gray-700 disabled:opacity-30"><ChevronLeft className="h-4 w-4" /></button>
            <button disabled={!d?.next} onClick={() => d?.next && onNavigate(d.next.id)} title="Next entry for this entity" className="rounded-lg p-1.5 text-gray-400 ring-1 ring-gray-200 hover:text-gray-700 disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button>
            <button onClick={onClose} className="ml-2 text-gray-400 hover:text-gray-700"><X className="h-5 w-5" /></button>
          </span>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto p-5 text-sm">
          {detail.isLoading || !e ? (
            <div className="space-y-2">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-4 w-full animate-pulse rounded bg-gray-100" />)}</div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge cls={actionBadge(e.action)}>{e.action}</Badge>
                <Badge cls={e.success ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}>{e.success ? 'success' : 'failed'}</Badge>
                <span className="text-xs text-gray-400">{dt(e.createdAt)}</span>
              </div>

              <section>
                <p className="mb-2 text-xs font-semibold uppercase text-gray-400">Actor</p>
                <dl className="space-y-1.5">
                  <Field label="Admin" value={e.adminName ?? e.adminId ?? 'system'} />
                  <Field label="IP" value={e.ipAddress ?? '—'} />
                  <Field label="User agent" value={<span className="break-all text-xs">{e.userAgent ?? '—'}</span>} />
                </dl>
              </section>

              <section>
                <p className="mb-2 text-xs font-semibold uppercase text-gray-400">Entity · Request</p>
                <dl className="space-y-1.5">
                  <Field label="Module" value={e.module} />
                  <Field label="Entity" value={`${e.entity}${e.entityName ? ` · ${e.entityName}` : ''}`} />
                  <Field label="Entity ID" value={<span className="font-mono text-xs">{e.entityId ?? '—'}</span>} />
                  <Field
                    label="Request"
                    value={e.requestId ? (
                      <Link href={`/system/requests/${encodeURIComponent(e.requestId)}`} className="inline-flex items-center gap-1 font-mono text-xs text-[#465fff] hover:underline">
                        {e.requestId.slice(0, 8)}… <ExternalLink className="h-3 w-3" />
                      </Link>
                    ) : '—'}
                  />
                </dl>
                {link ? (
                  <Link href={link} className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:border-[#465fff] hover:text-[#465fff]">
                    <ExternalLink className="h-3.5 w-3.5" /> Open {e.entity}
                  </Link>
                ) : null}
              </section>

              {/* Per-entity timeline */}
              {d.timeline.length > 1 ? (
                <section>
                  <p className="mb-2 text-xs font-semibold uppercase text-gray-400">Entity Timeline</p>
                  <ol className="relative ml-2 space-y-2 border-l border-gray-200 pl-4">
                    {d.timeline.map((t) => (
                      <li key={t.id} className="relative">
                        <span className={`absolute -left-[21.5px] top-1.5 h-2.5 w-2.5 rounded-full ${t.id === e.id ? 'bg-[#465fff]' : t.success ? 'bg-emerald-400' : 'bg-red-400'}`} />
                        <button onClick={() => onNavigate(t.id)} className={`w-full rounded px-1.5 py-0.5 text-left text-xs hover:bg-gray-50 ${t.id === e.id ? 'font-semibold text-gray-900' : 'text-gray-600'}`}>
                          {t.action} · {t.adminName ?? 'system'} · {dt(t.createdAt)}
                        </button>
                      </li>
                    ))}
                  </ol>
                </section>
              ) : null}

              {/* Diff viewer */}
              <section>
                <p className="mb-2 text-xs font-semibold uppercase text-gray-400">Diff</p>
                {rows.length === 0 ? (
                  <p className="text-sm text-gray-500">No field-level changes recorded.</p>
                ) : (
                  <div className="overflow-hidden rounded-xl border border-gray-100">
                    <table className="w-full text-xs">
                      <thead><tr className="border-b border-gray-100 bg-gray-50 text-left uppercase text-gray-400"><th className="px-3 py-2 font-medium">Field</th><th className="px-3 py-2 font-medium">Before</th><th className="px-3 py-2 font-medium">After</th></tr></thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr key={r.field} className="border-b border-gray-50 last:border-0">
                            <td className="px-3 py-2 font-mono font-medium text-gray-700">{r.field}</td>
                            <td className="max-w-[160px] break-all bg-red-50/60 px-3 py-2 text-red-700">{r.before}</td>
                            <td className="max-w-[160px] break-all bg-emerald-50/60 px-3 py-2 text-emerald-700">{r.after}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {e.before ? <JsonSection title="Before" value={e.before} onCopy={copy} /> : null}
              {e.after ? <JsonSection title="After" value={e.after} onCopy={copy} /> : null}
              {e.metadata ? <JsonSection title="Metadata" value={e.metadata} onCopy={copy} /> : null}

              <section>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase text-gray-400">Raw JSON</p>
                  <span className="flex gap-3">
                    <button onClick={() => copy(rawJson)} className="inline-flex items-center gap-1 text-xs font-medium text-[#465fff]"><Copy className="h-3.5 w-3.5" /> Copy</button>
                    <button onClick={download} className="inline-flex items-center gap-1 text-xs font-medium text-[#465fff]"><Download className="h-3.5 w-3.5" /> Download JSON</button>
                  </span>
                </div>
                <pre className="max-h-72 overflow-auto rounded-lg bg-gray-50 p-3 text-xs text-gray-700">{rawJson}</pre>
              </section>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

function JsonSection({ title, value, onCopy }: { title: string; value: unknown; onCopy: (s: string) => void }) {
  const json = JSON.stringify(value, null, 2);
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-semibold uppercase text-gray-400">{title}</p>
        <button onClick={() => onCopy(json)} className="inline-flex items-center gap-1 text-xs font-medium text-[#465fff]"><Copy className="h-3.5 w-3.5" /> Copy</button>
      </div>
      <pre className="max-h-48 overflow-auto rounded-lg bg-gray-50 p-3 text-xs text-gray-700">{json}</pre>
    </section>
  );
}

function Badge({ cls, children }: { cls: string; children: ReactNode }) {
  return <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-semibold ${cls}`}>{children}</span>;
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="shrink-0 text-gray-400">{label}</dt>
      <dd className="text-right font-medium text-gray-800">{value}</dd>
    </div>
  );
}

function Filter({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="space-y-1 text-sm">
      <span className="block text-xs uppercase text-gray-400">{label}</span>
      {children}
    </label>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'error' }) {
  const color = tone === 'error' ? 'text-red-600' : tone === 'ok' ? 'text-emerald-600' : 'text-gray-900';
  return (
    <Card>
      <p className="text-sm text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${color}`}>{value}</p>
    </Card>
  );
}

function Skeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="animate-pulse"><div className="h-3 w-2/3 rounded bg-gray-200" /><div className="mt-2 h-6 w-1/3 rounded bg-gray-200" /></Card>
        ))}
      </div>
      <Card className="h-96 animate-pulse"><div className="h-full w-full rounded bg-gray-100" /></Card>
    </div>
  );
}
