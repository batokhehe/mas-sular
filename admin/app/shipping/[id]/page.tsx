'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminShell } from '@/components/layout/admin-shell';
import { ShipmentForm, ShipmentFormValues } from '@/app/shipping/components/shipment-form';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchAdminOrders, fetchAdminShipment, updateAdminShipment, deleteAdminShipment } from '@/lib/admin';

export default function ShipmentDetailPage() {
  const router = useRouter();
  const params = useParams();
  const shipmentId = typeof params?.id === 'string' ? params.id : undefined;
  const queryClient = useQueryClient();

  const shipmentQuery = useQuery({
    queryKey: ['admin-shipment', shipmentId],
    queryFn: () => (shipmentId ? fetchAdminShipment(shipmentId) : Promise.reject(new Error('Missing shipment id'))),
    enabled: Boolean(shipmentId),
    retry: false,
  });

  const ordersQuery = useQuery({
    queryKey: ['admin-orders'],
    queryFn: fetchAdminOrders,
    retry: false,
  });

  const updateShipment = useMutation({
    mutationFn: ({ id, input }: { id: string; input: ShipmentFormValues }) => updateAdminShipment(id, input),
    onSuccess: () => {
      if (shipmentId) {
        queryClient.invalidateQueries({ queryKey: ['admin-shipment', shipmentId] });
      }
      queryClient.invalidateQueries({ queryKey: ['admin-shipments'] });
    },
  });

  const deleteShipment = useMutation({
    mutationFn: () => {
      if (!shipmentId) throw new Error('Missing shipment id');
      return deleteAdminShipment(shipmentId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-shipments'] });
      router.push('/shipping');
    },
  });

  if (shipmentQuery.isLoading || ordersQuery.isLoading) {
    return (
      <AdminShell requiredPermissions={ROUTE_PERMISSIONS.shipmentUpdate}>
        <p className="text-sm text-gray-500">Loading shipment details…</p>
      </AdminShell>
    );
  }

  if (shipmentQuery.isError || !shipmentQuery.data || ordersQuery.isError || !ordersQuery.data) {
    return (
      <AdminShell requiredPermissions={ROUTE_PERMISSIONS.shipmentUpdate}>
        <div className="space-y-3 rounded-2xl border border-red-100 bg-red-50 p-6 text-sm text-red-700">
          <p>Unable to load shipment details. Please try again later.</p>
          <Link href="/shipping" className="font-medium text-[#465fff] underline">Back to shipments</Link>
        </div>
      </AdminShell>
    );
  }

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.shipmentUpdate}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Edit Shipment</h2>
          <p className="mt-1 text-sm text-gray-500">Update shipment details and tracking information.</p>
        </div>
        <Link href="/shipping" className="text-sm font-medium text-[#465fff] hover:text-indigo-700">Back to shipments</Link>
      </div>
      <ShipmentForm
        orders={ordersQuery.data}
        initialValues={shipmentQuery.data}
        onSubmit={async (values) => {
          if (!shipmentId) return;
          await updateShipment.mutateAsync({ id: shipmentId, input: values });
          return;
        }}
        onDelete={async () => {
          await deleteShipment.mutateAsync();
          return;
        }}
        submitLabel={updateShipment.isPending ? 'Save changes' : 'Save shipment'}
        isSubmitting={updateShipment.isPending}
        isDeleting={deleteShipment.isPending}
      />
    </AdminShell>
  );
}
