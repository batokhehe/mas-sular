'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PermissionGate } from '@/components/auth/permission-gate';
import { AdminShell } from '@/components/layout/admin-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchAdminPendingPayments, rejectAdminPayment, verifyAdminPayment } from '@/lib/admin';

export default function PaymentsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-payments', 'pending'],
    queryFn: fetchAdminPendingPayments,
    retry: false,
  });
  const refreshQueue = () => queryClient.invalidateQueries({ queryKey: ['admin-payments', 'pending'] });
  const verifyMutation = useMutation({ mutationFn: verifyAdminPayment, onSuccess: refreshQueue });
  const rejectMutation = useMutation({ mutationFn: rejectAdminPayment, onSuccess: refreshQueue });

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.payments}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Payment Verification</h2>
          <p className="mt-1 text-sm text-gray-500">Manual transfer queue and future gateway webhook reconciliation.</p>
        </div>
        <PermissionGate permissions={ROUTE_PERMISSIONS.paymentVerify}>
          <Button>Verify Selected Payment</Button>
        </PermissionGate>
      </div>
      <Card>
        <CardTitle>Manual Transfer Queue</CardTitle>
        <div className="mt-4 space-y-3">
          {isLoading ? (
            <p className="p-6 text-sm text-gray-500">Loading payments...</p>
          ) : isError ? (
            <p className="p-6 text-sm text-red-600">Unable to load payments. Please reauthenticate.</p>
          ) : data?.length === 0 ? (
            <p className="p-6 text-sm text-gray-500">No payments waiting for verification.</p>
          ) : (
            data?.map((payment) => (
            <div key={payment.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-100 p-4">
              <div>
                <p className="font-medium text-gray-800">{payment.order.orderNumber}</p>
                <p className="text-sm text-gray-500">
                  {payment.manualBankName ?? payment.method} · Rp {payment.amount.toLocaleString('id-ID')}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone="brand">{payment.status}</Badge>
                <PermissionGate permissions={ROUTE_PERMISSIONS.paymentVerify}>
                  <Button onClick={() => verifyMutation.mutate(payment.id)}>Verify</Button>
                </PermissionGate>
                <PermissionGate permissions={ROUTE_PERMISSIONS.paymentReject}>
                  <Button className="bg-white text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50" onClick={() => rejectMutation.mutate(payment.id)}>Reject</Button>
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
