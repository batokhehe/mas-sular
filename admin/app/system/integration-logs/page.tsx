'use client';

import { ReactNode, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { AdminShell } from '@/components/layout/admin-shell';
import { Card, CardTitle } from '@/components/ui/card';
import { Pagination } from '@/components/ui/pagination';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import {
  fetchIntegrationLog,
  fetchIntegrationLogs,
  IntegrationLog,
  IntegrationLogDetail,
  IntegrationLogFilters,
  IntegrationOutcome,
  IntegrationProvider,
} from '@/lib/admin';
import {
  contextLabel,
  exactBody,
  exactEndpoint,
  formatAttempt,
  formatDuration,
  httpStatusTone,
  INTEGRATION_OUTCOMES,
  INTEGRATION_PROVIDERS,
  operationOptions,
  outcomeTone,
} from '@/lib/system/integration-log-view';

const dt = (iso: string) => new Date(iso).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'medium' });

const TONE_CLASS: Record<string, string> = {
  ok: 'bg-emerald-100 text-emerald-700',
  warn: 'bg-amber-100 text-amber-700',
  error: 'bg-red-100 text-red-700',
  none: 'bg-gray-100 text-gray-600',
};

const inputClass = 'h-10 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]';

function Tag({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-semibold ${TONE_CLASS[tone]}`}>{children}</span>;
}

export default function IntegrationLogsPage() {
  const [filters, setFilters] = useState<IntegrationLogFilters>({});
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const patch = (next: Partial<IntegrationLogFilters>) => {
    setFilters((current) => ({ ...current, ...next }));
    setPage(1);
  };

  const query = useQuery({
    queryKey: ['integration-logs', filters, page, limit],
    queryFn: () => fetchIntegrationLogs({ ...filters, page, limit }),
    placeholderData: keepPreviousData,
    retry: false,
  });

  const detail = useQuery({
    queryKey: ['integration-log', selectedId],
    queryFn: () => fetchIntegrationLog(selectedId as string),
    enabled: Boolean(selectedId),
    retry: false,
  });

  const rows = query.data?.items ?? [];

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.integrationLogs}>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900">Integration Logs</h2>
        <p className="mt-1 text-sm text-gray-500">
          Every external API exchange with Paxel, JNE and Midtrans — one record per HTTP attempt, plus the application outcome. The
          detail view shows the request and response exactly as exchanged, including credentials and personal data.
        </p>
      </div>

      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <input
            id="integration-search"
            defaultValue={filters.search ?? ''}
            onChange={(e) => patch({ search: e.target.value })}
            placeholder="Order, payment, shipment, operation id, endpoint or error…"
            className={`${inputClass} w-full md:w-80`}
          />
          <select value={filters.provider ?? ''} onChange={(e) => patch({ provider: e.target.value as IntegrationProvider | '', operation: '' })} className={inputClass}>
            <option value="">All providers</option>
            {INTEGRATION_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <select value={filters.operation ?? ''} onChange={(e) => patch({ operation: e.target.value })} className={inputClass}>
            <option value="">All operations</option>
            {operationOptions(filters.provider).map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </select>
          <select value={filters.direction ?? ''} onChange={(e) => patch({ direction: e.target.value as IntegrationLogFilters['direction'] })} className={inputClass}>
            <option value="">All directions</option>
            <option value="OUTBOUND">Outbound</option>
            <option value="INBOUND">Inbound (webhook)</option>
          </select>
          <select value={filters.applicationOutcome ?? ''} onChange={(e) => patch({ applicationOutcome: e.target.value as IntegrationOutcome | '' })} className={inputClass}>
            <option value="">All outcomes</option>
            {INTEGRATION_OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
          <input value={filters.httpStatus ?? ''} onChange={(e) => patch({ httpStatus: e.target.value.replace(/\D/g, '') })} placeholder="Status" className={`${inputClass} w-24`} />
          <input type="date" value={filters.dateFrom?.slice(0, 10) ?? ''} onChange={(e) => patch({ dateFrom: e.target.value })} className={inputClass} />
          <input type="date" value={filters.dateTo?.slice(0, 10) ?? ''} onChange={(e) => patch({ dateTo: e.target.value })} className={inputClass} />
        </div>

        <CardTitle>External API calls</CardTitle>
        <div className="mt-4 overflow-x-auto">
          {query.isLoading ? (
            <p className="p-6 text-sm text-gray-500">Loading integration logs...</p>
          ) : query.isError ? (
            <p className="p-6 text-sm text-red-600">Unable to load integration logs. Please reauthenticate.</p>
          ) : rows.length === 0 ? (
            <p className="p-6 text-sm text-gray-500">No external API calls match these filters.</p>
          ) : (
            <table className="w-full min-w-[1000px] text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                  <th className="py-3 font-medium">Time</th>
                  <th className="py-3 font-medium">Provider</th>
                  <th className="py-3 font-medium">Operation</th>
                  <th className="py-3 font-medium">Direction</th>
                  <th className="py-3 font-medium">HTTP</th>
                  <th className="py-3 font-medium">Duration</th>
                  <th className="py-3 font-medium">Order</th>
                  <th className="py-3 font-medium">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((log: IntegrationLog) => (
                  <tr key={log.id} onClick={() => setSelectedId(log.id)} className="cursor-pointer border-b border-gray-50 last:border-0 hover:bg-gray-50">
                    <td className="py-2.5 whitespace-nowrap text-gray-500">{dt(log.createdAt)}</td>
                    <td className="py-2.5 font-medium text-gray-800">{log.provider}</td>
                    <td className="py-2.5 font-mono text-xs text-gray-700">{log.operation}</td>
                    <td className="py-2.5 text-gray-500">{log.direction === 'INBOUND' ? 'Inbound' : 'Outbound'}</td>
                    <td className="py-2.5">
                      <Tag tone={httpStatusTone(log.httpStatus)}>{log.httpStatus ?? '—'}</Tag>
                    </td>
                    <td className="py-2.5 tabular-nums text-gray-600">{formatDuration(log.durationMs)}</td>
                    <td className="py-2.5 font-mono text-xs text-gray-600">{contextLabel(log)}</td>
                    <td className="py-2.5">
                      <Tag tone={outcomeTone(log.applicationOutcome)}>{log.applicationOutcome}</Tag>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <Pagination
          page={query.data?.page ?? page}
          totalPages={query.data?.totalPages ?? 1}
          total={query.data?.total ?? 0}
          limit={limit}
          onPageChange={setPage}
          onLimitChange={(next) => {
            setLimit(next);
            setPage(1);
          }}
        />
      </Card>

      {selectedId ? <LogDrawer log={detail.data} loading={detail.isLoading} onClose={() => setSelectedId(null)} /> : null}
    </AdminShell>
  );
}

function LogDrawer({ log, loading, onClose }: { log?: IntegrationLogDetail; loading: boolean; onClose: () => void }) {
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />
      <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <h3 className="font-semibold text-gray-900">Integration call detail</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto p-5 text-sm">
          {loading || !log ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-4 w-full animate-pulse rounded bg-gray-100" />
              ))}
            </div>
          ) : (
            <>
              <section>
                <p className="mb-2 text-xs font-semibold uppercase text-gray-400">Request</p>
                <dl className="space-y-1.5">
                  <Field label="Method" value={log.method ?? '—'} />
                  <Field label="URL" value={<span className="break-all font-mono text-xs">{exactEndpoint(log) ?? '—'}</span>} />
                </dl>
                <ExactPayload title="Request body" value={log.rawRequestBody} />
              </section>

              <section>
                <p className="mb-2 text-xs font-semibold uppercase text-gray-400">Response</p>
                <dl className="space-y-1.5">
                  <Field label="HTTP status" value={<Tag tone={httpStatusTone(log.httpStatus)}>{log.httpStatus ?? '—'}</Tag>} />
                  <Field label="Outcome" value={<Tag tone={outcomeTone(log.applicationOutcome)}>{log.applicationOutcome}</Tag>} />
                  {log.errorMessage ? <Field label="Error" value={<span className="whitespace-pre-wrap break-words text-right">{log.errorMessage}</span>} /> : null}
                  {log.errorClass ? <Field label="Error class" value={log.errorClass} /> : null}
                </dl>
                <ExactPayload title="Response body" value={log.rawResponseBody} />
              </section>

              <section>
                <p className="mb-2 text-xs font-semibold uppercase text-gray-400">Context</p>
                <dl className="space-y-1.5">
                  <Field label="Provider / operation" value={`${log.provider} · ${log.operation}`} />
                  <Field label="Direction" value={log.direction} />
                  <Field label="Attempt" value={formatAttempt(log)} />
                  <Field label="Duration" value={formatDuration(log.durationMs)} />
                  <Field label="Time" value={dt(log.createdAt)} />
                  <Field label="Operation ID" value={<span className="font-mono text-xs">{log.operationId}</span>} />
                  <Field label="Request ID" value={<span className="font-mono text-xs">{log.requestId ?? '—'}</span>} />
                  <Field label="Correlation ID" value={<span className="font-mono text-xs">{log.correlationId ?? '—'}</span>} />
                  <Field label="Order ID" value={<span className="font-mono text-xs">{log.orderId ?? '—'}</span>} />
                  <Field label="Payment ID" value={<span className="font-mono text-xs">{log.paymentId ?? '—'}</span>} />
                  <Field label="Shipment ID" value={<span className="font-mono text-xs">{log.shipmentId ?? '—'}</span>} />
                </dl>
              </section>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

/**
 * The body EXACTLY as exchanged with the provider — rendered verbatim (whitespace
 * preserved, no pretty-printing, masking or truncation). Collapsed by default:
 * opened deliberately, because it can hold credentials and personal data.
 */
function ExactPayload({ title, value }: { title: string; value: string | null }) {
  const body = exactBody(value);
  if (!body.captured) return <p className="mt-2 text-xs text-gray-400">{title}: not captured for this record</p>;
  if (body.empty) return <p className="mt-2 text-xs text-gray-400">{title}: (empty body)</p>;
  return (
    <details className="mt-2 rounded-lg border border-gray-100">
      <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-gray-600">{title} (exact)</summary>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-b-lg bg-gray-50 p-3 font-mono text-xs text-gray-700">{body.text}</pre>
    </details>
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
