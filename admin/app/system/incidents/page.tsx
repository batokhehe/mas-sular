'use client';

import { ReactNode, useState } from 'react';
import Link from 'next/link';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, CheckCheck, ExternalLink, RefreshCw, X } from 'lucide-react';
import { AdminShell } from '@/components/layout/admin-shell';
import { PermissionGate } from '@/components/auth/permission-gate';
import { Card, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/ui/pagination';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import {
  fetchIncidents, fetchIncident, acknowledgeIncident, resolveIncident,
  Incident, IncidentFilters, IncidentSeverity, IncidentStatus,
} from '@/lib/admin';
import { SEVERITY_BADGE, STATUS_BADGE, incidentDuration, incidentLinks, incidentActions } from '@/lib/system/incident-view';
import { LEVEL_BADGE } from '@/lib/system/request-explorer-view';
import { ADMIN_LOADING_MESSAGES, runWithFeedback } from '@/lib/admin-alert';

const SEVERITIES: IncidentSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
const STATUSES: IncidentStatus[] = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'];
const SOURCES = ['system-log', 'performance', 'queue', 'worker', 'cache', 'broker'];

const dt = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'medium' }) : '—');

export default function IncidentsPage() {
  const qc = useQueryClient();
  const [filters, setFilters] = useState<IncidentFilters>({});
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const patch = (p: Partial<IncidentFilters>) => {
    setFilters((f) => ({ ...f, ...p }));
    setPage(1);
  };

  const query = useQuery({
    queryKey: ['incidents', filters, page, limit],
    queryFn: () => fetchIncidents({ ...filters, page, limit }),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    refetchInterval: 30_000, // auto refresh
    retry: false,
  });
  const data = query.data;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['incidents'] });
    if (selectedId) qc.invalidateQueries({ queryKey: ['incident', selectedId] });
  };
  const ackM = useMutation({ mutationFn: acknowledgeIncident, onSuccess: refresh });
  const resolveM = useMutation({ mutationFn: resolveIncident, onSuccess: refresh });

  const ack = (id: string) =>
    runWithFeedback({ loading: ADMIN_LOADING_MESSAGES.update, success: 'Incident acknowledged', action: () => ackM.mutateAsync(id) });
  const resolve = (id: string) =>
    runWithFeedback({ loading: ADMIN_LOADING_MESSAGES.update, success: 'Incident resolved', action: () => resolveM.mutateAsync(id) });

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.incidents}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Incidents</h2>
          <p className="mt-1 text-sm text-gray-500">Auto-detected operational incidents — errors, backlogs, failing workers, latency.</p>
        </div>
        <Button onClick={() => void query.refetch()} disabled={query.isFetching} className="gap-2">
          <RefreshCw className={`h-4 w-4 ${query.isFetching ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </div>

      {query.isLoading ? (
        <Skeleton />
      ) : query.isError || !data ? (
        <Card>
          <div className="flex flex-col items-center gap-3 p-10 text-center">
            <AlertTriangle className="h-6 w-6 text-red-500" />
            <p className="text-sm text-red-600">Unable to load incidents.</p>
            <Button onClick={() => void query.refetch()}>Retry</Button>
          </div>
        </Card>
      ) : (
        <div className="space-y-6">
          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Stat label="Open" value={data.summary.open} tone={data.summary.open > 0 ? 'error' : undefined} />
            <Stat label="Critical" value={data.summary.critical} tone={data.summary.critical > 0 ? 'error' : undefined} />
            <Stat label="High" value={data.summary.high} tone={data.summary.high > 0 ? 'warn' : undefined} />
            <Stat label="Acknowledged" value={data.summary.acknowledged} />
            <Stat label="Resolved Today" value={data.summary.resolvedToday} tone="ok" />
          </div>

          <Card>
            {/* Filters */}
            <div className="flex flex-wrap items-end gap-3">
              <Filter label="Status">
                <select value={filters.status ?? ''} onChange={(e) => patch({ status: e.target.value as IncidentStatus | '' })} className="h-10 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]">
                  <option value="">All</option>{STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </Filter>
              <Filter label="Severity">
                <select value={filters.severity ?? ''} onChange={(e) => patch({ severity: e.target.value as IncidentSeverity | '' })} className="h-10 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]">
                  <option value="">All</option>{SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </Filter>
              <Filter label="Source">
                <select value={filters.source ?? ''} onChange={(e) => patch({ source: e.target.value || undefined })} className="h-10 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]">
                  <option value="">All</option>{SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </Filter>
              <Filter label="Worker"><input defaultValue={filters.worker ?? ''} onChange={(e) => patch({ worker: e.target.value || undefined })} placeholder="payment-lifecycle" className="h-10 w-44 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]" /></Filter>
              <Filter label="Module"><input defaultValue={filters.module ?? ''} onChange={(e) => patch({ module: e.target.value || undefined })} placeholder="http" className="h-10 w-32 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]" /></Filter>
              <Filter label="From"><input type="datetime-local" onChange={(e) => patch({ dateFrom: e.target.value ? new Date(e.target.value).toISOString() : undefined })} className="h-10 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]" /></Filter>
              <Filter label="To"><input type="datetime-local" onChange={(e) => patch({ dateTo: e.target.value ? new Date(e.target.value).toISOString() : undefined })} className="h-10 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]" /></Filter>
            </div>

            <CardTitle className="mt-5">Incidents</CardTitle>
            <div className="mt-4 overflow-x-auto">
              {(data.items.length ?? 0) === 0 ? (
                <p className="p-10 text-center text-sm text-gray-500">No incidents — all clear.</p>
              ) : (
                <table className="w-full min-w-[1050px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                      <th className="py-2 font-medium">Severity</th><th className="py-2 font-medium">Status</th><th className="py-2 font-medium">Title</th>
                      <th className="py-2 font-medium">Source</th><th className="py-2 text-right font-medium">Count</th>
                      <th className="py-2 font-medium">First Seen</th><th className="py-2 font-medium">Last Seen</th><th className="py-2 font-medium">Duration</th>
                      <th className="py-2 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((i) => {
                      const actions = incidentActions(i.status);
                      return (
                        <tr key={i.id} onClick={() => setSelectedId(i.id)} className="cursor-pointer border-b border-gray-50 last:border-0 hover:bg-gray-50/70">
                          <td className="py-2.5"><Badge cls={SEVERITY_BADGE[i.severity]}>{i.severity}</Badge></td>
                          <td className="py-2.5"><Badge cls={STATUS_BADGE[i.status]}>{i.status}</Badge></td>
                          <td className="max-w-[300px] truncate py-2.5 font-medium text-gray-800" title={i.title}>{i.title}</td>
                          <td className="py-2.5 text-gray-500">{i.source}</td>
                          <td className="py-2.5 text-right text-gray-600">{i.count}</td>
                          <td className="whitespace-nowrap py-2.5 text-gray-500">{dt(i.firstSeen)}</td>
                          <td className="whitespace-nowrap py-2.5 text-gray-500">{dt(i.lastSeen)}</td>
                          <td className="py-2.5 text-gray-500">{incidentDuration(i.firstSeen, i.lastSeen)}</td>
                          <td className="py-2.5">
                            <span className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                              {actions.canAcknowledge ? (
                                <PermissionGate permissions={ROUTE_PERMISSIONS.incidentManage}>
                                  <button onClick={() => void ack(i.id)} title="Acknowledge" className="rounded-lg px-2 py-1 text-xs font-medium text-amber-700 ring-1 ring-amber-200 hover:bg-amber-50"><Check className="h-3.5 w-3.5" /></button>
                                </PermissionGate>
                              ) : null}
                              {actions.canResolve ? (
                                <PermissionGate permissions={ROUTE_PERMISSIONS.incidentManage}>
                                  <button onClick={() => void resolve(i.id)} title="Resolve" className="rounded-lg px-2 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-50"><CheckCheck className="h-3.5 w-3.5" /></button>
                                </PermissionGate>
                              ) : null}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
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

      {selectedId ? (
        <IncidentDrawer
          id={selectedId}
          onClose={() => setSelectedId(null)}
          onAck={(id) => void ack(id)}
          onResolve={(id) => void resolve(id)}
        />
      ) : null}
    </AdminShell>
  );
}

function IncidentDrawer({ id, onClose, onAck, onResolve }: { id: string; onClose: () => void; onAck: (id: string) => void; onResolve: (id: string) => void }) {
  const detail = useQuery({ queryKey: ['incident', id], queryFn: () => fetchIncident(id), retry: false });
  const d = detail.data;
  const incident = d?.incident;
  const actions = incident ? incidentActions(incident.status) : { canAcknowledge: false, canResolve: false };
  const links = incident ? incidentLinks(incident) : [];

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />
      <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <h3 className="font-semibold text-gray-900">Incident detail</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><X className="h-5 w-5" /></button>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto p-5 text-sm">
          {detail.isLoading || !incident ? (
            <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-4 w-full animate-pulse rounded bg-gray-100" />)}</div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge cls={SEVERITY_BADGE[incident.severity]}>{incident.severity}</Badge>
                <Badge cls={STATUS_BADGE[incident.status]}>{incident.status}</Badge>
                <span className="text-xs text-gray-400">{incident.type}</span>
              </div>
              <div>
                <p className="font-semibold text-gray-900">{incident.title}</p>
                <p className="mt-1 text-gray-600">{incident.description}</p>
              </div>

              {(actions.canAcknowledge || actions.canResolve) ? (
                <PermissionGate permissions={ROUTE_PERMISSIONS.incidentManage}>
                  <div className="flex gap-2">
                    {actions.canAcknowledge ? <Button onClick={() => onAck(incident.id)} className="gap-2 bg-amber-500 hover:bg-amber-600"><Check className="h-4 w-4" /> Acknowledge</Button> : null}
                    {actions.canResolve ? <Button onClick={() => onResolve(incident.id)} className="gap-2 bg-emerald-600 hover:bg-emerald-700"><CheckCheck className="h-4 w-4" /> Resolve</Button> : null}
                  </div>
                </PermissionGate>
              ) : null}

              <section>
                <p className="mb-2 text-xs font-semibold uppercase text-gray-400">General</p>
                <dl className="space-y-1.5">
                  <Field label="Source" value={incident.source} />
                  <Field label="Occurrences" value={String(incident.count)} />
                  <Field label="First seen" value={dt(incident.firstSeen)} />
                  <Field label="Last seen" value={dt(incident.lastSeen)} />
                  <Field label="Duration" value={incidentDuration(incident.firstSeen, incident.lastSeen)} />
                  {incident.worker ? <Field label="Worker" value={incident.worker} /> : null}
                  {incident.module ? <Field label="Module" value={incident.module} /> : null}
                  {incident.acknowledgedAt ? <Field label="Acknowledged" value={`${dt(incident.acknowledgedAt)} · ${incident.acknowledgedBy ?? ''}`} /> : null}
                  {incident.resolvedAt ? <Field label="Resolved" value={`${dt(incident.resolvedAt)} · ${incident.resolvedBy ?? ''}`} /> : null}
                </dl>
              </section>

              {links.length > 0 ? (
                <section>
                  <p className="mb-2 text-xs font-semibold uppercase text-gray-400">Related</p>
                  <div className="flex flex-wrap gap-2">
                    {links.map((l) => (
                      <Link key={l.label} href={l.href} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:border-[#465fff] hover:text-[#465fff]">
                        <ExternalLink className="h-3.5 w-3.5" /> {l.label} <span className="font-mono text-gray-400">{l.id.slice(0, 8)}…</span>
                      </Link>
                    ))}
                  </div>
                </section>
              ) : null}

              <section>
                <p className="mb-2 text-xs font-semibold uppercase text-gray-400">Timeline (correlated logs)</p>
                {d.timeline.length === 0 ? (
                  <p className="text-sm text-gray-500">No correlated log entries.</p>
                ) : (
                  <ol className="space-y-1.5">
                    {d.timeline.map((e) => (
                      <li key={e.id} className="rounded-lg bg-gray-50 px-3 py-2">
                        <p className="flex flex-wrap items-center gap-2 text-xs">
                          <span className={`rounded px-1.5 py-0.5 font-semibold ${LEVEL_BADGE[e.level]}`}>{e.level}</span>
                          <span className="text-gray-400">{dt(e.createdAt)}</span>
                          <span className="font-medium text-gray-700">{e.module} · {e.action}</span>
                          {e.durationMs != null ? <span className="text-gray-400">{e.durationMs}ms</span> : null}
                        </p>
                        <p className="mt-0.5 truncate text-xs text-gray-600" title={e.message}>{e.message}</p>
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              <section>
                <p className="mb-2 text-xs font-semibold uppercase text-gray-400">Metadata</p>
                <pre className="max-h-64 overflow-auto rounded-lg bg-gray-50 p-3 text-xs text-gray-700">{JSON.stringify(incident.metadata ?? {}, null, 2)}</pre>
              </section>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

function Badge({ cls, children }: { cls: string; children: ReactNode }) {
  return <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-semibold ${cls}`}>{children}</span>;
}

function Filter({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="space-y-1 text-sm">
      <span className="block text-xs uppercase text-gray-400">{label}</span>
      {children}
    </label>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="shrink-0 text-gray-400">{label}</dt>
      <dd className="text-right font-medium text-gray-800">{value}</dd>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'ok' | 'warn' | 'error' }) {
  const color = tone === 'error' ? 'text-red-600' : tone === 'warn' ? 'text-orange-600' : tone === 'ok' ? 'text-emerald-600' : 'text-gray-900';
  return (
    <Card>
      <p className="text-sm text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${color}`}>{value.toLocaleString('id-ID')}</p>
    </Card>
  );
}

function Skeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i} className="animate-pulse"><div className="h-3 w-2/3 rounded bg-gray-200" /><div className="mt-2 h-6 w-1/3 rounded bg-gray-200" /></Card>
        ))}
      </div>
      <Card className="h-96 animate-pulse"><div className="h-full w-full rounded bg-gray-100" /></Card>
    </div>
  );
}
