'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { PermissionGate } from '@/components/auth/permission-gate';
import { AdminShell } from '@/components/layout/admin-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchAdminOrder, updateAdminOrderStatus, AdminOrderDetail } from '@/lib/admin';

const orderStatusOptions = ['PROCESSING', 'DELIVERING', 'COMPLETED', 'CANCELLED'] as const;

export default function OrderDetailPage() {
  const params = useParams();
  const orderId = typeof params?.id === 'string' ? params.id : undefined;
  const queryClient = useQueryClient();
  const [nextStatus, setNextStatus] = useState<typeof orderStatusOptions[number]>('PROCESSING');
  const [note, setNote] = useState('');

  const { data: order, isLoading, isError } = useQuery({
    queryKey: ['admin-order', orderId],
    queryFn: () => (orderId ? fetchAdminOrder(orderId) : Promise.reject(new Error('Missing order ID'))),
    enabled: Boolean(orderId),
    retry: false,
  });

  useEffect(() => {
    if (order) {
      setNextStatus(order.status as typeof orderStatusOptions[number]);
    }
  }, [order]);

  const statusMutation = useMutation<AdminOrderDetail, Error, void>({
    mutationFn: async () => {
      if (!orderId) {
        throw new Error('Missing order ID');
      }
      return updateAdminOrderStatus(orderId, nextStatus, note);
    },
    onSuccess: () => {
      if (orderId) {
        queryClient.invalidateQueries({ queryKey: ['admin-order', orderId] });
      }
      queryClient.invalidateQueries({ queryKey: ['admin-orders'] });
    },
  });

  if (isLoading) {
    return (
      <AdminShell requiredPermissions={ROUTE_PERMISSIONS.orders}>
        <p className="text-sm text-gray-500">Loading order details…</p>
      </AdminShell>
    );
  }

  if (isError || !order) {
    return (
      <AdminShell requiredPermissions={ROUTE_PERMISSIONS.orders}>
        <p className="text-sm text-red-600">Unable to load order details. Please try again later.</p>
      </AdminShell>
    );
  }

  const formattedDate = new Date(order.createdAt).toLocaleString('id-ID', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.orders}>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900">Order {order.orderNumber}</h2>
        <p className="mt-1 text-sm text-gray-500">Order placed on {formattedDate}</p>
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.3fr_0.7fr]">
        <Card>
          <CardTitle>Summary</CardTitle>
          <div className="mt-4 space-y-4 text-sm text-gray-700">
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <p className="text-xs uppercase text-gray-400">Status</p>
                <Badge tone={order.status === 'COMPLETED' ? 'success' : order.status === 'PENDING' ? 'danger' : 'brand'} className="mt-2">
                  {order.status}
                </Badge>
              </div>
              <div>
                <p className="text-xs uppercase text-gray-400">Total</p>
                <p className="mt-2 font-semibold text-gray-900">Rp {order.totalPrice.toLocaleString('id-ID')}</p>
              </div>
              <div>
                <p className="text-xs uppercase text-gray-400">Customer</p>
                <p className="mt-2 font-medium text-gray-900">{order.user?.name ?? 'Guest'}</p>
                <p className="text-sm text-gray-500">{order.user?.email ?? 'No email provided'}</p>
              </div>
              <div>
                <p className="text-xs uppercase text-gray-400">Payment</p>
                <p className="mt-2 font-medium text-gray-900">{order.payment?.method ?? order.paymentMethod}</p>
                <p className="text-sm text-gray-500">{order.payment?.status ?? 'Unknown'}</p>
              </div>
            </div>

            {order.shipment ? (
              <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                <p className="text-xs uppercase text-gray-400">Shipment</p>
                <p className="mt-2 font-medium text-gray-900">{order.shipment.provider} • {order.shipment.service}</p>
                <p className="text-sm text-gray-500">Status: {order.shipment.status}</p>
                {order.shipment.trackingNumber ? (
                  <p className="text-sm text-gray-500">Tracking: {order.shipment.trackingNumber}</p>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="mt-8">
            <p className="text-sm uppercase tracking-wide text-gray-500">Order items</p>
            <div className="mt-4 space-y-4">
              {order.items.map((item) => (
                <div key={item.id} className="rounded-2xl border border-gray-200 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-medium text-gray-900">{item.productName}</p>
                      <p className="mt-1 text-sm text-gray-500">Qty {item.quantity} • Rp {item.unitPrice.toLocaleString('id-ID')}</p>
                    </div>
                    <p className="text-sm font-semibold text-gray-900">Rp {(item.unitPrice * item.quantity).toLocaleString('id-ID')}</p>
                  </div>
                  {item.notes ? <p className="mt-3 text-sm text-gray-500">Notes: {item.notes}</p> : null}
                  {item.toppings.length > 0 ? (
                    <p className="mt-3 text-sm text-gray-500">
                      Toppings: {item.toppings.map((topping) => topping.name).join(', ')}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </Card>

        <Card>
          <CardTitle>Admin Actions</CardTitle>
          <div className="mt-4 space-y-4 text-sm text-gray-700">
            <PermissionGate
              permissions={ROUTE_PERMISSIONS.orderUpdate}
              fallback={<p className="rounded-xl bg-gray-50 p-4 text-sm text-gray-500">Your role can view this order but cannot update its status.</p>}
            >
              <div>
                <label className="block text-xs uppercase text-gray-500">New status</label>
                <select
                  value={nextStatus}
                  onChange={(event) => setNextStatus(event.target.value as typeof orderStatusOptions[number])}
                  className="mt-2 h-11 w-full rounded-xl border border-gray-200 bg-white px-4 text-sm outline-none focus:border-[#465fff]"
                >
                  {orderStatusOptions.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs uppercase text-gray-500">Note</label>
                <textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  rows={4}
                  className="mt-2 w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm outline-none focus:border-[#465fff]"
                  placeholder="Add an optional internal note for this status update"
                />
              </div>

              <Button
                onClick={() => statusMutation.mutate()}
                disabled={statusMutation.isPending}
                className="w-full"
              >
                {statusMutation.isPending ? 'Updating...' : 'Update Order Status'}
              </Button>

              {statusMutation.isError ? (
                <p className="text-sm text-red-600">Unable to update order status. Please try again.</p>
              ) : null}
            </PermissionGate>
          </div>

          <div className="mt-8">
            <p className="text-xs uppercase tracking-wide text-gray-500">Order timeline</p>
            <div className="mt-4 space-y-3">
              {order.events.map((event) => (
                <div key={event.id} className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                  <p className="text-sm font-medium text-gray-900">{event.status}</p>
                  <p className="mt-1 text-sm text-gray-500">{event.note ?? 'No details provided'}</p>
                  <p className="mt-2 text-xs text-gray-400">{new Date(event.createdAt).toLocaleString('id-ID')}</p>
                </div>
              ))}
            </div>
          </div>
        </Card>
      </div>
    </AdminShell>
  );
}
