'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDown, ArrowUp, Minus, Wallet, ShoppingBag, Clock, CheckCircle2, Package, Truck, PackageCheck, XCircle,
  Boxes, MapPin, Store, ClipboardList, PlusCircle, AlertTriangle,
} from 'lucide-react';
import { AdminShell } from '@/components/layout/admin-shell';
import { Badge } from '@/components/ui/badge';
import { Card, CardTitle } from '@/components/ui/card';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchExecutiveDashboard, ExecutiveDashboard, HealthLevel } from '@/lib/admin';
import { useAdminAuthStatus, useAdminProfile } from '@/lib/auth';
import { canViewDashboard, DASHBOARD_ROUTE, firstAccessibleRoute } from '@/lib/navigation';
import { TrendChart, DonutChart } from '@/components/dashboard/charts';
import { formatRupiah } from '@/lib/utils/number';

const rp = formatRupiah;
const RANGES = [
  { label: '7 Hari', days: 7 },
  { label: '30 Hari', days: 30 },
  { label: '90 Hari', days: 90 },
  { label: '1 Tahun', days: 365 },
] as const;

const METHOD_COLORS: Record<string, string> = { BANK_TRANSFER: '#465fff', QRIS: '#22c55e', COD: '#f59e0b', GATEWAY: '#a855f7' };
const STATUS_COLORS: Record<string, string> = {
  PAID: '#22c55e', PENDING: '#f59e0b', WAITING_VERIFICATION: '#3b82f6', EXPIRED: '#9ca3af', FAILED: '#ef4444', REFUNDED: '#a855f7',
};
const HEALTH_DOT: Record<HealthLevel, string> = { green: 'bg-emerald-500', yellow: 'bg-amber-400', red: 'bg-red-500' };
const HEALTH_LABEL: Record<HealthLevel, string> = { green: 'Operational', yellow: 'Degraded', red: 'Down' };

export default function DashboardPage() {
  const router = useRouter();
  const authStatus = useAdminAuthStatus();
  const profile = useAdminProfile({ enabled: authStatus.isInitialized && authStatus.hasToken });
  // Decided from GET /admin/auth/me (the server's live permissions), not the cached list.
  const permissions = profile.data?.permissions;
  const mayView = profile.isSuccess && canViewDashboard(permissions);
  // Admins without Dashboard.read never request the executive data (no 403 per poll).
  const canFetch = mayView;

  // `/` and old bookmarks lead here; send admins without Dashboard.read to their first
  // accessible page instead of leaving them on a "Permission required" panel.
  const fallbackRoute = profile.isSuccess && !mayView ? firstAccessibleRoute(permissions) : null;
  useEffect(() => {
    if (fallbackRoute && fallbackRoute !== DASHBOARD_ROUTE) router.replace(fallbackRoute);
  }, [fallbackRoute, router]);

  const query = useQuery({
    queryKey: ['exec-dashboard'],
    queryFn: fetchExecutiveDashboard,
    enabled: canFetch,
    retry: false,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const d = query.data;

  const [range, setRange] = useState<number>(30);
  const [metric, setMetric] = useState<'revenue' | 'orders'>('revenue');

  const chartPoints = useMemo(() => {
    if (!d) return [];
    return d.salesChart.slice(-range).map((p) => ({ label: p.date, value: metric === 'revenue' ? p.revenue : p.orders }));
  }, [d, range, metric]);

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.dashboard}>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Dasbor Eksekutif</h2>
          <p className="mt-1 text-sm text-gray-500">Ringkasan operasional langsung Bakso Mas Sular.</p>
        </div>
        {d ? <p className="text-xs text-gray-400">Diperbarui {new Date(d.generatedAt).toLocaleTimeString('id-ID')}</p> : null}
      </div>

      {query.isLoading ? (
        <DashboardSkeleton />
      ) : query.isError || !d ? (
        <Card>
          <div className="flex items-center gap-3 p-6 text-sm text-red-600">
            <AlertTriangle className="h-5 w-5" />
            Gagal memuat dasbor. Silakan masuk ulang atau coba lagi.
          </div>
        </Card>
      ) : (
        <div className="space-y-6">
          {/* SECTION 1 — Today's Summary */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <DeltaCard label="Pendapatan Hari Ini" value={rp(d.summary.todayRevenue.value)} delta={d.summary.todayRevenue} icon={Wallet} />
            <DeltaCard label="Pesanan Hari Ini" value={String(d.summary.todayOrders.value)} delta={d.summary.todayOrders} icon={ShoppingBag} />
            <StatCard label="Pembayaran Tertunda" value={d.summary.pendingPayments} icon={Clock} tone="amber" />
            <StatCard label="Menunggu Verifikasi" value={d.summary.pendingVerification} icon={ClipboardList} tone="blue" />
            <StatCard label="Sedang Disiapkan" value={d.summary.processing} icon={Package} tone="blue" />
            <StatCard label="Dikirim" value={d.summary.shipped} icon={Truck} tone="indigo" />
            <StatCard label="Terkirim" value={d.summary.delivered} icon={PackageCheck} tone="emerald" />
            <StatCard label="Dibatalkan" value={d.summary.cancelled} icon={XCircle} tone="red" />
          </div>

          {/* SECTION 2 & 3 — Sales overview + Payment overview */}
          <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
            <Card>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle>Ringkasan Penjualan</CardTitle>
                  <p className="mt-1 text-sm text-gray-500">Tren pendapatan & pesanan</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <div className="flex rounded-lg bg-gray-100 p-1 text-xs">
                    {(['revenue', 'orders'] as const).map((m) => (
                      <button key={m} onClick={() => setMetric(m)} className={`rounded-md px-2.5 py-1 capitalize ${metric === m ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>
                        {m}
                      </button>
                    ))}
                  </div>
                  <div className="flex rounded-lg bg-gray-100 p-1 text-xs">
                    {RANGES.map((r) => (
                      <button key={r.days} onClick={() => setRange(r.days)} className={`rounded-md px-2.5 py-1 ${range === r.days ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>
                        {r.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <TrendChart points={chartPoints} color={metric === 'revenue' ? '#465fff' : '#22c55e'} />
              <div className="mt-3 flex justify-between text-xs text-gray-400">
                <span>{chartPoints[0]?.label ?? ''}</span>
                <span>{chartPoints[chartPoints.length - 1]?.label ?? ''}</span>
              </div>
            </Card>

            <Card>
              <CardTitle>Ringkasan Pembayaran</CardTitle>
              <div className="mt-5 space-y-6">
                <div>
                  <p className="mb-3 text-xs font-medium uppercase text-gray-400">Per Metode</p>
                  <DonutChart
                    segments={d.paymentChart.byMethod.filter((s) => s.count > 0).map((s) => ({ label: s.key, value: s.count, color: METHOD_COLORS[s.key] ?? '#94a3b8' }))}
                  />
                </div>
                <div className="border-t border-gray-100 pt-5">
                  <p className="mb-3 text-xs font-medium uppercase text-gray-400">Per Status</p>
                  <DonutChart
                    segments={d.paymentChart.byStatus.filter((s) => s.count > 0).map((s) => ({ label: s.key, value: s.count, color: STATUS_COLORS[s.key] ?? '#94a3b8' }))}
                  />
                </div>
              </div>
            </Card>
          </div>

          {/* SECTION 4 & 5 — Top products + Top customers */}
          <div className="grid gap-6 xl:grid-cols-2">
            <Card>
              <CardTitle>Produk Terlaris</CardTitle>
              <div className="mt-4 overflow-x-auto">
                {d.topProducts.length === 0 ? (
                  <p className="p-6 text-sm text-gray-500">Belum ada penjualan.</p>
                ) : (
                  <table className="w-full min-w-[520px] text-left text-sm">
                    <thead>
                      <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                        <th className="py-2 font-medium">Produk</th>
                        <th className="py-2 text-right font-medium">Qty</th>
                        <th className="py-2 text-right font-medium">Pendapatan</th>
                        <th className="py-2 text-right font-medium">Rata-rata</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.topProducts.map((p) => (
                        <tr key={p.productId} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/60">
                          <td className="py-3 font-medium text-gray-800">
                            <Link href={`/products/${p.productId}`} className="text-[#465fff] hover:underline">{p.name}</Link>
                          </td>
                          <td className="py-3 text-right text-gray-600">{p.qtySold}</td>
                          <td className="py-3 text-right font-semibold text-gray-900">{rp(p.revenue)}</td>
                          <td className="py-3 text-right text-gray-500">{rp(p.avgPrice)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </Card>

            <Card>
              <CardTitle>Pelanggan Teratas</CardTitle>
              <div className="mt-4 overflow-x-auto">
                {d.topCustomers.length === 0 ? (
                  <p className="p-6 text-sm text-gray-500">Belum ada pelanggan.</p>
                ) : (
                  <table className="w-full min-w-[520px] text-left text-sm">
                    <thead>
                      <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                        <th className="py-2 font-medium">Pelanggan</th>
                        <th className="py-2 text-right font-medium">Pesanan</th>
                        <th className="py-2 text-right font-medium">Pendapatan</th>
                        <th className="py-2 text-right font-medium">Pesanan Terakhir</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.topCustomers.map((c) => (
                        <tr key={c.userId} className="border-b border-gray-50 last:border-0">
                          <td className="py-3">
                            <p className="font-medium text-gray-800">{c.name}</p>
                            <p className="text-xs text-gray-400">{c.email}</p>
                          </td>
                          <td className="py-3 text-right text-gray-600">{c.orders}</td>
                          <td className="py-3 text-right font-semibold text-gray-900">{rp(c.revenue)}</td>
                          <td className="py-3 text-right text-gray-500">{c.lastOrder ? new Date(c.lastOrder).toLocaleDateString('id-ID') : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </Card>
          </div>

          {/* SECTION 6 — Recent orders */}
          <Card>
            <div className="mb-4 flex items-center justify-between">
              <CardTitle>Pesanan Terbaru</CardTitle>
              <Link href="/orders" className="text-sm font-medium text-[#465fff] hover:underline">Lihat semua</Link>
            </div>
            <div className="overflow-x-auto">
              {d.recentOrders.length === 0 ? (
                <p className="p-6 text-sm text-gray-500">Belum ada pesanan.</p>
              ) : (
                <table className="w-full min-w-[760px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                      <th className="py-2 font-medium">Pesanan</th>
                      <th className="py-2 font-medium">Pelanggan</th>
                      <th className="py-2 font-medium">Pembayaran</th>
                      <th className="py-2 font-medium">Status</th>
                      <th className="py-2 font-medium">Pengiriman</th>
                      <th className="py-2 text-right font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.recentOrders.map((o) => (
                      <tr key={o.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/60">
                        <td className="py-3 font-medium text-gray-800">
                          <Link href={`/orders/${o.id}`} className="text-[#465fff] hover:underline">{o.orderNumber}</Link>
                        </td>
                        <td className="py-3 text-gray-600">{o.customer}</td>
                        <td className="py-3 text-gray-500">{o.paymentStatus}</td>
                        <td className="py-3"><Badge tone={o.orderStatus === 'CANCELLED' ? 'danger' : o.orderStatus === 'DELIVERED' ? 'success' : 'brand'}>{o.orderStatus}</Badge></td>
                        <td className="py-3 text-gray-500">{o.shipmentStatus ?? '—'}</td>
                        <td className="py-3 text-right font-semibold text-gray-900">{rp(o.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </Card>

          {/* SECTION 7 & 8 — Inventory alerts + Shipment overview */}
          <div className="grid gap-6 xl:grid-cols-2">
            <Card>
              <CardTitle>Peringatan Stok</CardTitle>
              <div className="mt-4 grid grid-cols-3 gap-3">
                <MiniStat label="Stok Menipis" value={d.inventoryAlert.lowStock} tone="amber" />
                <MiniStat label="Stok Habis" value={d.inventoryAlert.outOfStock} tone="red" />
                <MiniStat label="Direservasi" value={d.inventoryAlert.reserved} tone="blue" />
              </div>
              <div className="mt-4">
                <p className="mb-2 text-xs font-medium uppercase text-gray-400">Perlu Restok</p>
                {d.inventoryAlert.needRestock.length === 0 ? (
                  <p className="text-sm text-gray-500">Semua produk memiliki stok yang cukup.</p>
                ) : (
                  <ul className="space-y-2">
                    {d.inventoryAlert.needRestock.map((p) => (
                      <li key={p.id} className={`flex items-center justify-between rounded-lg border p-2.5 text-sm ${p.stock <= 0 ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'}`}>
                        <Link href={`/products/${p.id}`} className="font-medium text-gray-800 hover:underline">{p.name}</Link>
                        <span className={`font-semibold ${p.stock <= 0 ? 'text-red-600' : 'text-amber-700'}`}>sisa {p.stock}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Card>

            <Card>
              <CardTitle>Ringkasan Pengiriman</CardTitle>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <MiniStat label="Menunggu Dikirim" value={d.shipmentSummary.waiting} tone="amber" icon={Clock} />
                <MiniStat label="Dalam Perjalanan" value={d.shipmentSummary.inTransit} tone="blue" icon={Truck} />
                <MiniStat label="Terkirim Hari Ini" value={d.shipmentSummary.deliveredToday} tone="emerald" icon={PackageCheck} />
                <MiniStat label="Pengiriman Gagal" value={d.shipmentSummary.failed} tone="red" icon={XCircle} />
              </div>
            </Card>
          </div>

          {/* SECTION 9 & 10 — Quick actions + System health */}
          <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
            <Card>
              <CardTitle>Aksi Cepat</CardTitle>
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                <QuickAction href="/products/new" label="Buat Produk" icon={PlusCircle} />
                <QuickAction href="/orders" label="Lihat Pesanan" icon={ClipboardList} />
                <QuickAction href="/payments" label="Pembayaran Tertunda" icon={Wallet} />
                <QuickAction href="/inventory/products" label="Stok" icon={Boxes} />
                <QuickAction href="/delivery-coverage" label="Jangkauan Pengiriman" icon={MapPin} />
                <QuickAction href="/outlets" label="Outlet" icon={Store} />
              </div>
            </Card>

            <Card>
              <CardTitle>Kesehatan Sistem</CardTitle>
              <ul className="mt-4 space-y-2.5">
                {([
                  ['Database', d.systemHealth.database],
                  ['Redis', d.systemHealth.redis],
                  ['RabbitMQ', d.systemHealth.rabbitmq],
                  ['Worker', d.systemHealth.worker],
                  ['Notification', d.systemHealth.notification],
                ] as Array<[string, HealthLevel]>).map(([name, level]) => (
                  <li key={name} className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2.5 text-sm">
                    <span className="text-gray-700">{name}</span>
                    <span className="flex items-center gap-2">
                      <span className={`h-2.5 w-2.5 rounded-full ${HEALTH_DOT[level]}`} />
                      <span className="text-xs text-gray-500">{HEALTH_LABEL[level]}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </div>
      )}
    </AdminShell>
  );
}

/* ---------------- small presentational pieces ---------------- */

type Delta = { changePct: number; direction: 'up' | 'down' | 'flat' };
type IconType = typeof Wallet;

function DeltaCard({ label, value, delta, icon: Icon }: { label: string; value: string; delta: Delta; icon: IconType }) {
  const TrendIcon = delta.direction === 'up' ? ArrowUp : delta.direction === 'down' ? ArrowDown : Minus;
  const tone = delta.direction === 'up' ? 'success' : delta.direction === 'down' ? 'danger' : 'brand';
  return (
    <Card>
      <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-gray-100 text-gray-700">
        <Icon className="h-5 w-5" />
      </div>
      <p className="text-sm text-gray-500">{label}</p>
      <div className="mt-1 flex items-end justify-between gap-2">
        <p className="text-2xl font-semibold text-gray-900">{value}</p>
        <Badge tone={tone} className="gap-1">
          <TrendIcon className="h-3 w-3" />
          {Math.abs(delta.changePct)}%
        </Badge>
      </div>
      <p className="mt-1 text-xs text-gray-400">vs kemarin</p>
    </Card>
  );
}

function StatCard({ label, value, icon: Icon, tone }: { label: string; value: number; icon: IconType; tone: keyof typeof TONE }) {
  return (
    <Card>
      <div className={`mb-4 flex h-10 w-10 items-center justify-center rounded-xl ${TONE[tone]}`}>
        <Icon className="h-5 w-5" />
      </div>
      <p className="text-sm text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-gray-900">{value}</p>
    </Card>
  );
}

function MiniStat({ label, value, tone, icon: Icon }: { label: string; value: number; tone: keyof typeof TONE; icon?: IconType }) {
  return (
    <div className="rounded-xl border border-gray-100 p-3">
      <div className="flex items-center gap-2 text-gray-500">
        {Icon ? <Icon className="h-4 w-4" /> : null}
        <span className="text-xs">{label}</span>
      </div>
      <p className={`mt-1.5 text-xl font-semibold ${value > 0 && (tone === 'red') ? 'text-red-600' : 'text-gray-900'}`}>{value}</p>
    </div>
  );
}

function QuickAction({ href, label, icon: Icon }: { href: string; label: string; icon: IconType }) {
  return (
    <Link href={href} className="flex items-center gap-2 rounded-xl border border-gray-200 px-3 py-3 text-sm font-medium text-gray-700 transition hover:border-[#465fff] hover:bg-[#465fff]/5 hover:text-[#465fff]">
      <Icon className="h-4 w-4" />
      {label}
    </Link>
  );
}

const TONE = {
  amber: 'bg-amber-100 text-amber-700',
  red: 'bg-red-100 text-red-700',
  blue: 'bg-blue-100 text-blue-700',
  indigo: 'bg-indigo-100 text-indigo-700',
  emerald: 'bg-emerald-100 text-emerald-700',
} as const;

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Card key={i} className="animate-pulse">
            <div className="mb-4 h-10 w-10 rounded-xl bg-gray-100" />
            <div className="h-3 w-2/3 rounded bg-gray-200" />
            <div className="mt-2 h-6 w-1/2 rounded bg-gray-200" />
          </Card>
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
        <Card className="h-[300px] animate-pulse"><div className="h-full w-full rounded-lg bg-gray-100" /></Card>
        <Card className="h-[300px] animate-pulse"><div className="h-full w-full rounded-lg bg-gray-100" /></Card>
      </div>
    </div>
  );
}
