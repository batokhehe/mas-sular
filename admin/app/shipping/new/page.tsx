'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { AdminShell } from '@/components/layout/admin-shell';
import { ShipmentForm, ShipmentFormValues } from '@/app/shipping/components/shipment-form';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchAdminOrders, createAdminShipment } from '@/lib/admin';
import { ADMIN_LOADING_MESSAGES, ADMIN_SUCCESS_MESSAGES, runWithFeedback } from '@/lib/admin-alert';

export default function NewShipmentPage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const ordersQuery = useQuery({
    queryKey: ['admin-orders', 'shipment-options'],
    queryFn: () => fetchAdminOrders({ limit: 100 }),
    retry: false,
  });

  const createShipment = useMutation({
    mutationFn: (input: ShipmentFormValues) => createAdminShipment(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-shipments'] });
      router.push('/shipping');
    },
  });

  if (ordersQuery.isLoading) {
    return (
      <AdminShell requiredPermissions={ROUTE_PERMISSIONS.shipmentCreate}>
        <p className="text-sm text-gray-500">Loading orders…</p>
      </AdminShell>
    );
  }

  if (ordersQuery.isError || !ordersQuery.data) {
    return (
      <AdminShell requiredPermissions={ROUTE_PERMISSIONS.shipmentCreate}>
        <p className="text-sm text-red-600">Unable to load orders. Please reauthenticate.</p>
      </AdminShell>
    );
  }

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.shipmentCreate}>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900">New Shipment</h2>
        <p className="mt-1 text-sm text-gray-500">Create a shipment record for an existing order.</p>
      </div>
      <ShipmentForm
        orders={ordersQuery.data.items}
        onSubmit={async (values) => {
          await runWithFeedback({
            loading: ADMIN_LOADING_MESSAGES.create,
            success: ADMIN_SUCCESS_MESSAGES.created('Shipment'),
            action: () => createShipment.mutateAsync(values),
          });
        }}
        submitLabel={createShipment.isPending ? 'Creating...' : 'Create Shipment'}
        isSubmitting={createShipment.isPending}
      />
    </AdminShell>
  );
}
