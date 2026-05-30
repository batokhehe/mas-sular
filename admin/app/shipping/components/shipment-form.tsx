'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { AdminOrder, AdminShipment } from '@/lib/admin';

export type ShipmentFormValues = {
  orderId: string;
  provider: string;
  service: string;
  cost: number;
  status: string;
  trackingNumber?: string;
  trackingUrl?: string;
};

interface ShipmentFormProps {
  orders?: AdminOrder[];
  initialValues?: Partial<AdminShipment>;
  onSubmit: (values: ShipmentFormValues) => Promise<void>;
  onDelete?: () => Promise<void>;
  submitLabel: string;
  isSubmitting?: boolean;
  isDeleting?: boolean;
}

const statusOptions = ['PENDING', 'RATE_SELECTED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'FAILED'] as const;

export function ShipmentForm({
  orders = [],
  initialValues,
  onSubmit,
  onDelete,
  submitLabel,
  isSubmitting,
  isDeleting,
}: ShipmentFormProps) {
  const [values, setValues] = useState<ShipmentFormValues>({
    orderId: initialValues?.order?.id ?? orders[0]?.id ?? '',
    provider: initialValues?.provider ?? '',
    service: initialValues?.service ?? '',
    cost: initialValues?.cost ?? 0,
    status: initialValues?.status ?? 'PENDING',
    trackingNumber: initialValues?.trackingNumber ?? '',
    trackingUrl: initialValues?.trackingUrl ?? '',
  });

  const orderOptions = useMemo(
    () => orders.map((order) => ({ value: order.id, label: order.orderNumber || order.id })),
    [orders],
  );

  const handleChange = (field: keyof ShipmentFormValues, value: string | number) => {
    setValues((current) => ({
      ...current,
      [field]: field === 'cost' ? Number(value) : value,
    }));
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await onSubmit(values);
  };

  return (
    <Card>
      <CardTitle>{submitLabel}</CardTitle>
      <form onSubmit={handleSubmit} className="mt-4 space-y-6">
        <div className="grid gap-4 lg:grid-cols-2">
          <label className="space-y-2 text-sm text-gray-700">
            <span>Order</span>
            <select
              value={values.orderId}
              onChange={(event) => handleChange('orderId', event.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm outline-none focus:border-[#465fff]"
              required
            >
              {orderOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Provider</span>
            <input
              value={values.provider}
              onChange={(event) => handleChange('provider', event.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
              required
            />
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Service</span>
            <input
              value={values.service}
              onChange={(event) => handleChange('service', event.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
              required
            />
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Cost</span>
            <input
              type="number"
              min={0}
              value={values.cost}
              onChange={(event) => handleChange('cost', event.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
              required
            />
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Status</span>
            <select
              value={values.status}
              onChange={(event) => handleChange('status', event.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm outline-none focus:border-[#465fff]"
            >
              {statusOptions.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Tracking number</span>
            <input
              value={values.trackingNumber ?? ''}
              onChange={(event) => handleChange('trackingNumber', event.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
            />
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Tracking URL</span>
            <input
              type="url"
              value={values.trackingUrl ?? ''}
              onChange={(event) => handleChange('trackingUrl', event.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
            />
          </label>
        </div>

        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={isSubmitting}>{submitLabel}</Button>
          {onDelete ? (
            <Button type="button" className="bg-white text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50" disabled={isDeleting} onClick={onDelete}>
              Delete
            </Button>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
