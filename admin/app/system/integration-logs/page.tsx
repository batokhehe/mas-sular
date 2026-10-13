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
        <h2 className="text-xl font-semibold text-gray-900">Log Integrasi</h2>
        <p className="mt-1 text-sm text-gray-500">
          Setiap pertukaran API eksternal dengan Paxel, JNE, dan Midtrans — satu catatan per percobaan HTTP, beserta hasil di aplikasi. Tampilan
          detail menunjukkan request dan respons persis seperti yang dipertukarkan, termasuk kredensial dan data pribadi.
        </p>
      </div>

      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <input
            id="integration-search"
            defaultValue={filters.search ?? ''}
            onChange={(e) => patch({ search: e.target.value })}
            placeholder="Pesanan, pembayaran, pengiriman, operation id, endpoint, atau error…"
            className={`${inputClass} w-full md:w-80`}
          />
          <select value={filters.provider ?? ''} onChange={(e) => patch({ provider: e.target.value as IntegrationProvider | '', operation: '' })} className={inputClass}>
            <option value="">Semua penyedia</option>
            {INTEGRATION_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <select value={filters.operation ?? ''} onChange={(e) => patch({ operation: e.target.value })} className={inputClass}>
            <option value="">Semua operasi</option>
            {operationOptions(filters.provider).map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </select>
          <select value={filters.direction ?? ''} onChange={(e) => patch({ direction: e.target.value as IntegrationLogFilters['direction'] })} className={inputClass}>
            <option value="">Semua arah</option>
            <option value="OUTBOUND">Keluar</option>
            <option value="INBOUND">Inbound (webhook)</option>
          </select>
          <select value={filters.applicationOutcome ?? ''} onChange={(e) => patch({ applicationOutcome: e.target.value as IntegrationOutcome | '' })} className={inputClass}>
            <option value="">Semua hasil</option>
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

        <CardTitle>Panggilan API eksternal</CardTitle>
        <div className="mt-4 overflow-x-auto">
          {query.isLoading ? (
            <p className="p-6 text-sm text-gray-500">Memuat log integrasi...</p>
          ) : query.isError ? (
            <p className="p-6 text-sm text-red-600">Gagal memuat log integrasi. Silakan masuk ulang.</p>
          ) : rows.length === 0 ? (
            <p className="p-6 text-sm text-gray-500">Tidak ada panggilan API eksternal yang cocok dengan filter ini.</p>
          ) : (
            <table className="w-full min-w-[1000px] text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                  <th className="py-3 font-medium">Waktu</th>
                  <th className="py-3 font-medium">Penyedia</th>
                  <th className="py-3 font-medium">Operasi</th>
                  <th className="py-3 font-medium">Arah</th>
                  <th className="py-3 font-medium">HTTP</th>
                  <th className="py-3 font-medium">Durasi</th>
                  <th className="py-3 font-medium">Pesanan</th>
                  <th className="py-3 font-medium">Hasil</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((log: IntegrationLog) => (
                  <tr key={log.id} onClick={() => setSelectedId(log.id)} className="cursor-pointer border-b border-gray-50 last:border-0 hover:bg-gray-50">
                    <td className="py-2.5 whitespace-nowrap text-gray-500">{dt(log.createdAt)}</td>
                    <td className="py-2.5 font-medium text-gray-800">{log.provider}</td>
                    <td className="py-2.5 font-mono text-xs text-gray-700">{log.operation}</td>
                    <td className="py-2.5 text-gray-500">{log.direction === 'INBOUND' ? 'Masuk' : 'Keluar'}</td>
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
                  <Field label="Metode" value={log.method ?? '—'} />
                  <Field label="URL" value={<span className="break-all font-mono text-xs">{exactEndpoint(log) ?? '—'}</span>} />
                </dl>
                <ExactPayload title="Body request" value={log.rawRequestBody} />
              </section>

              <section>
                <p className="mb-2 text-xs font-semibold uppercase text-gray-400">Respons</p>
                <dl className="space-y-1.5">
                  <Field label="Status HTTP" value={<Tag tone={httpStatusTone(log.httpStatus)}>{log.httpStatus ?? '—'}</Tag>} />
                  <Field label="Hasil" value={<Tag tone={outcomeTone(log.applicationOutcome)}>{log.applicationOutcome}</Tag>} />
                  {log.errorMessage ? <Field label="Error" value={<span className="whitespace-pre-wrap break-words text-right">{log.errorMessage}</span>} /> : null}
                  {log.errorClass ? <Field label="Kelas error" value={log.errorClass} /> : null}
                </dl>
                <ExactPayload title="Body respons" value={log.rawResponseBody} />
              </section>

              <section>
                <p className="mb-2 text-xs font-semibold uppercase text-gray-400">Konteks</p>
                <dl className="space-y-1.5">
                  <Field label="Penyedia / operasi" value={`${log.provider} · ${log.operation}`} />
                  <Field label="Arah" value={log.direction} />
                  <Field label="Percobaan" value={formatAttempt(log)} />
                  <Field label="Durasi" value={formatDuration(log.durationMs)} />
                  <Field label="Waktu" value={dt(log.createdAt)} />
                  <Field label="Operation ID" value={<span className="font-mono text-xs">{log.operationId}</span>} />
                  <Field label="Request ID" value={<span className="font-mono text-xs">{log.requestId ?? '—'}</span>} />
                  <Field label="Correlation ID" value={<span className="font-mono text-xs">{log.correlationId ?? '—'}</span>} />
                  <Field label="ID Pesanan" value={<span className="font-mono text-xs">{log.orderId ?? '—'}</span>} />
                  <Field label="ID Pembayaran" value={<span className="font-mono text-xs">{log.paymentId ?? '—'}</span>} />
                  <Field label="ID Pengiriman" value={<span className="font-mono text-xs">{log.shipmentId ?? '—'}</span>} />
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
  if (!body.captured) return <p className="mt-2 text-xs text-gray-400">{title}: tidak tercatat untuk data ini</p>;
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
