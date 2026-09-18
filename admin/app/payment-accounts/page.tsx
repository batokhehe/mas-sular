'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PermissionGate } from '@/components/auth/permission-gate';
import { AdminShell } from '@/components/layout/admin-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { activatePaymentAccount, deletePaymentAccount, fetchPaymentAccounts } from '@/lib/admin';
import {
  ADMIN_LOADING_MESSAGES,
  ADMIN_SUCCESS_MESSAGES,
  confirmDelete,
  confirmStatusChange,
  runWithFeedback,
} from '@/lib/admin-alert';

export default function PaymentAccountsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-payment-accounts'],
    queryFn: fetchPaymentAccounts,
    retry: false,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin-payment-accounts'] });
  const activateMutation = useMutation({ mutationFn: activatePaymentAccount, onSuccess: refresh });
  const deleteMutation = useMutation({ mutationFn: deletePaymentAccount, onSuccess: refresh });

  const handleActivate = (id: string) =>
    runWithFeedback({
      confirm: () => confirmStatusChange('Nonaktif', 'Aktif', { title: 'Aktifkan rekening ini?' }),
      loading: ADMIN_LOADING_MESSAGES.update,
      success: ADMIN_SUCCESS_MESSAGES.updated,
      action: () => activateMutation.mutateAsync(id),
    });

  const handleDelete = (id: string) =>
    runWithFeedback({
      confirm: () => confirmDelete('Rekening Pembayaran'),
      loading: ADMIN_LOADING_MESSAGES.delete,
      success: ADMIN_SUCCESS_MESSAGES.deleted('Rekening Pembayaran'),
      action: () => deleteMutation.mutateAsync(id),
    });

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.paymentAccounts}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Rekening Pembayaran</h2>
          <p className="mt-1 text-sm text-gray-500">Rekening bank yang dipakai di notifikasi WhatsApp checkout. Tepat satu yang aktif.</p>
        </div>
        <PermissionGate permissions={ROUTE_PERMISSIONS.paymentAccountCreate}>
          <Link href="/payment-accounts/new">
            <Button>Tambah Rekening</Button>
          </Link>
        </PermissionGate>
      </div>

      <Card>
        <CardTitle>Daftar Rekening</CardTitle>
        <div className="mt-4 space-y-3">
          {isLoading ? (
            <p className="p-6 text-sm text-gray-500">Memuat rekening pembayaran...</p>
          ) : isError ? (
            <p className="p-6 text-sm text-red-600">Gagal memuat rekening pembayaran. Silakan masuk ulang.</p>
          ) : data?.length === 0 ? (
            <p className="p-6 text-sm text-gray-500">Belum ada rekening pembayaran.</p>
          ) : (
            data?.map((account) => (
              <div key={account.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-100 p-4">
                <div>
                  <p className="font-medium text-gray-800">
                    {account.bankName} {account.bankCode ? `(${account.bankCode})` : ''}
                  </p>
                  <p className="text-sm text-gray-500">
                    {account.accountName} · {account.accountNumber}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {account.isActive ? <Badge tone="success">Aktif</Badge> : <Badge tone="brand">Nonaktif</Badge>}
                  {account.isVisible ? <Badge tone="brand">Ditampilkan</Badge> : null}
                  {!account.isActive ? (
                    <PermissionGate permissions={ROUTE_PERMISSIONS.paymentAccountActivate}>
                      <Button onClick={() => handleActivate(account.id)}>Aktifkan</Button>
                    </PermissionGate>
                  ) : null}
                  <PermissionGate permissions={ROUTE_PERMISSIONS.paymentAccountUpdate}>
                    <Link href={`/payment-accounts/${account.id}`}>
                      <Button className="bg-white text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50">Ubah</Button>
                    </Link>
                  </PermissionGate>
                  {!account.isActive ? (
                    <PermissionGate permissions={ROUTE_PERMISSIONS.paymentAccountDelete}>
                      <Button
                        className="bg-white text-red-600 ring-1 ring-gray-200 hover:bg-gray-50"
                        onClick={() => handleDelete(account.id)}
                      >
                        Hapus
                      </Button>
                    </PermissionGate>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>
      </Card>
    </AdminShell>
  );
}
