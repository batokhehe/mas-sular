'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PermissionGate } from '@/components/auth/permission-gate';
import { AdminShell } from '@/components/layout/admin-shell';
import { Badge } from '@/components/ui/badge';
import { paymentStatusLabel } from '@/lib/status-labels';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchAdminPendingPayments, rejectAdminPayment, verifyAdminPayment } from '@/lib/admin';
import { ADMIN_LOADING_MESSAGES, ADMIN_SUCCESS_MESSAGES, confirmApprove, confirmReject, runWithFeedback } from '@/lib/admin-alert';
import { ReceiptCell } from '@/components/payments/receipt-cell';

export default function PaymentsPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-payments', 'pending', search],
    queryFn: () => fetchAdminPendingPayments(search),
    retry: false,
  });
  const refreshQueue = () => queryClient.invalidateQueries({ queryKey: ['admin-payments', 'pending'] });
  const verifyMutation = useMutation({ mutationFn: verifyAdminPayment, onSuccess: refreshQueue });
  const rejectMutation = useMutation({ mutationFn: rejectAdminPayment, onSuccess: refreshQueue });

  const [selectedPaymentIds, setSelectedPaymentIds] = useState<string[]>([]);
  const toggleSelection = (paymentId: string) =>
    setSelectedPaymentIds((current) =>
      current.includes(paymentId) ? current.filter((id) => id !== paymentId) : [...current, paymentId],
    );

  const handleVerify = (paymentId: string) =>
    runWithFeedback({
      confirm: () =>
        confirmApprove({
          title: 'Verifikasi pembayaran?',
          text: 'Pembayaran ini akan ditandai Lunas dan pesanan akan berpindah ke status Diproses.',
        }),
      loading: ADMIN_LOADING_MESSAGES.verify,
      success: ADMIN_SUCCESS_MESSAGES.paymentVerified,
      action: () => verifyMutation.mutateAsync(paymentId),
    });

  const handleReject = (paymentId: string) =>
    runWithFeedback({
      confirm: () =>
        confirmReject({
          title: 'Tolak pembayaran?',
          text: 'Pembayaran ini akan ditolak dan stok dikembalikan.',
        }),
      loading: ADMIN_LOADING_MESSAGES.reject,
      success: ADMIN_SUCCESS_MESSAGES.paymentRejected,
      action: () => rejectMutation.mutateAsync(paymentId),
    });

  // Bulk verify: sequential per selected id, no backend bulk endpoint. Individual
  // failures are caught so the run completes; one aggregated toast at the end.
  const handleBulkVerify = () =>
    runWithFeedback<{ successCount: number; failureCount: number }>({
      confirm: () =>
        confirmApprove({
          title: 'Verifikasi pembayaran terpilih?',
          text: `${selectedPaymentIds.length} pembayaran akan ditandai Lunas.`,
        }),
      loading: ADMIN_LOADING_MESSAGES.verify,
      success: ({ successCount, failureCount }) =>
        failureCount === 0
          ? `${successCount} pembayaran berhasil diverifikasi`
          : `${successCount} terverifikasi, ${failureCount} gagal`,
      action: async () => {
        let successCount = 0;
        let failureCount = 0;
        for (const id of selectedPaymentIds) {
          try {
            await verifyMutation.mutateAsync(id);
            successCount += 1;
          } catch {
            failureCount += 1;
          }
        }
        setSelectedPaymentIds([]);
        return { successCount, failureCount };
      },
    });

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.payments}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Verifikasi Pembayaran</h2>
          <p className="mt-1 text-sm text-gray-500">Antrean transfer manual dan rekonsiliasi webhook gateway.</p>
        </div>
        <PermissionGate permissions={ROUTE_PERMISSIONS.paymentVerify}>
          <Button
            onClick={handleBulkVerify}
            disabled={selectedPaymentIds.length === 0 || verifyMutation.isPending}
          >
            Verify Selected Payment{selectedPaymentIds.length > 0 ? ` (${selectedPaymentIds.length})` : ''}
          </Button>
        </PermissionGate>
      </div>
      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Antrean Transfer Manual</CardTitle>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Cari pesanan, pelanggan, atau nominal transfer (mis. 135123)"
            className="h-10 w-full rounded-xl border border-gray-200 bg-gray-50 px-4 text-sm outline-none focus:border-[#465fff] focus:bg-white sm:w-96"
          />
        </div>
        <div className="mt-4 space-y-3">
          {isLoading ? (
            <p className="p-6 text-sm text-gray-500">Memuat pembayaran...</p>
          ) : isError ? (
            <p className="p-6 text-sm text-red-600">Gagal memuat pembayaran. Silakan masuk ulang.</p>
          ) : data?.length === 0 ? (
            <p className="p-6 text-sm text-gray-500">Tidak ada pembayaran yang menunggu verifikasi.</p>
          ) : (
            data?.map((payment) => (
            <div key={payment.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-100 p-4">
              <div className="flex flex-1 flex-wrap items-center gap-3">
                <PermissionGate permissions={ROUTE_PERMISSIONS.paymentVerify}>
                  <input
                    type="checkbox"
                    checked={selectedPaymentIds.includes(payment.id)}
                    onChange={() => toggleSelection(payment.id)}
                    className="h-4 w-4 rounded border-gray-300 text-[#465fff] focus:ring-[#465fff]"
                    aria-label={`Pilih pembayaran ${payment.order.orderNumber}`}
                  />
                </PermissionGate>
                <div className="min-w-0">
                  <p className="font-medium text-gray-800">{payment.order.orderNumber}</p>
                  <p className="text-sm text-gray-500">
                    {payment.manualBankName ?? payment.method}
                    {payment.uniqueCode != null ? (
                      <> · Kode unik <span className="font-semibold text-gray-700">{payment.uniqueCode}</span></>
                    ) : null}
                  </p>
                  {payment.uniqueCode != null ? (
                    <p className="text-sm text-gray-500">
                      Total pesanan:{' '}
                      <span className="font-semibold text-gray-700">Rp {payment.order.totalPrice.toLocaleString('id-ID')}</span>
                    </p>
                  ) : null}
                  <p className="text-sm text-gray-500">
                    {payment.uniqueCode != null ? 'Nominal transfer' : 'Total pembayaran'}:{' '}
                    <span className="font-semibold text-gray-700">Rp {payment.amount.toLocaleString('id-ID')}</span>
                  </p>
                </div>
                {/* Receipt: inline on desktop, wraps below the info on mobile (w-full → new line). */}
                <div className="w-full sm:ml-1 sm:w-auto">
                  <ReceiptCell url={payment.manualReceiptUrl} orderNumber={payment.order.orderNumber} />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone="brand">{paymentStatusLabel(payment.status)}</Badge>
                <PermissionGate permissions={ROUTE_PERMISSIONS.paymentVerify}>
                  <Button onClick={() => handleVerify(payment.id)} disabled={verifyMutation.isPending}>Verifikasi</Button>
                </PermissionGate>
                <PermissionGate permissions={ROUTE_PERMISSIONS.paymentReject}>
                  <Button className="bg-white text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50" onClick={() => handleReject(payment.id)} disabled={rejectMutation.isPending}>Tolak</Button>
                </PermissionGate>
              </div>
            </div>
            ))
          )}
        </div>
      </Card>
    </AdminShell>
  );
}
