'use client';

import { useState } from 'react';
import { AdminOrder, PAXEL_SERVICE_OPTIONS, PrepareShipmentResult, prepareShipments } from '@/lib/admin';

/**
 * Admin packing action.
 *
 * The pickup date and time are the whole reason this panel exists: Paxel will
 * not book without them, and the application has no operating-hours model from
 * which a sensible slot could be derived, so a person states it. Nothing here
 * defaults the time.
 *
 * Insurance is shown read-only. It is a server configuration
 * (PAXEL_NEED_INSURANCE) because it costs money per shipment, and letting an
 * operator flip it per batch would make the bill unpredictable.
 */

interface Props {
  selected: AdminOrder[];
  onDone: () => void;
  onClear: () => void;
}

export function PrepareShipmentPanel({ selected, onDone, onClear }: Props) {
  const [service, setService] = useState<string>('PAXEL_SAMEDAY');
  const [pickupDate, setPickupDate] = useState('');
  const [pickupTime, setPickupTime] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<PrepareShipmentResult[] | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const canSubmit = selected.length > 0 && !!pickupDate && !!pickupTime && !submitting;

  async function submit() {
    setFormError(null);
    if (!selected.length) return setFormError('Select at least one order.');
    if (!pickupDate) return setFormError('Pickup date is required.');
    if (!pickupTime) return setFormError('Pickup time is required.');

    // Local wall-clock -> instant. The operator picks a time in their own
    // timezone; the server stores and sends exactly this instant.
    const pickupAt = new Date(`${pickupDate}T${pickupTime}`);
    if (Number.isNaN(pickupAt.getTime())) return setFormError('Pickup date and time are invalid.');

    setSubmitting(true);
    try {
      const response = await prepareShipments({
        orderIds: selected.map((order) => order.id),
        pickupAt: pickupAt.toISOString(),
        service,
      });
      setResults(response.results);
      // Refresh regardless: a partial batch changed some orders.
      onDone();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to create shipments.');
    } finally {
      setSubmitting(false);
    }
  }

  const booked = results?.filter((r) => r.ok) ?? [];
  const failed = results?.filter((r) => !r.ok) ?? [];

  return (
    <div className="mb-4 rounded-2xl border border-[#465fff]/30 bg-[#465fff]/5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-gray-800">
          Prepare Shipment · {selected.length} order{selected.length === 1 ? '' : 's'} selected
        </p>
        <button type="button" onClick={onClear} className="text-xs font-medium text-gray-500 hover:text-gray-700">
          Clear selection
        </button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-xs font-medium text-gray-500">
          Courier
          <input
            value="Paxel"
            readOnly
            className="mt-1 h-10 w-full rounded-xl border border-gray-200 bg-gray-100 px-3 text-sm text-gray-700"
          />
        </label>
        <label className="text-xs font-medium text-gray-500">
          Service
          <select
            value={service}
            onChange={(event) => setService(event.target.value)}
            className="mt-1 h-10 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]"
          >
            {PAXEL_SERVICE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-gray-500">
          Pickup date <span className="text-red-500">*</span>
          <input
            type="date"
            value={pickupDate}
            onChange={(event) => setPickupDate(event.target.value)}
            className="mt-1 h-10 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]"
          />
        </label>
        <label className="text-xs font-medium text-gray-500">
          Pickup time <span className="text-red-500">*</span>
          <input
            type="time"
            value={pickupTime}
            onChange={(event) => setPickupTime(event.target.value)}
            className="mt-1 h-10 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]"
          />
        </label>
      </div>

      <p className="mt-3 text-xs text-gray-500">
        Insurance: <span className="font-medium text-gray-700">OFF</span> — set by server configuration.
      </p>

      <div className="mt-3 rounded-xl border border-gray-200 bg-white p-3">
        <p className="text-xs font-medium text-gray-500">Review</p>
        <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-700">
          {selected.map((order) => (
            <li key={order.id}>{order.orderNumber}</li>
          ))}
        </ul>
      </div>

      {formError ? <p className="mt-3 text-sm text-red-600">{formError}</p> : null}

      <div className="mt-4">
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className="h-10 rounded-xl bg-[#465fff] px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-gray-300"
        >
          {submitting ? 'Creating…' : 'Create Shipment'}
        </button>
      </div>

      {results ? (
        <div className="mt-4 space-y-2">
          {booked.length > 0 ? (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
              <p className="font-medium">{booked.length} shipment{booked.length === 1 ? '' : 's'} created</p>
              <ul className="mt-1 space-y-0.5">
                {booked.map((result) => (
                  <li key={result.orderId}>AWB {result.trackingNumber}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {/* A partial batch is never reported as a success. Each failure names
              itself and its reason so the operator can fix that one order. */}
          {failed.length > 0 ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              <p className="font-medium">{failed.length} shipment{failed.length === 1 ? '' : 's'} not created</p>
              <ul className="mt-1 space-y-0.5">
                {failed.map((result) => (
                  <li key={result.orderId}>
                    {selected.find((order) => order.id === result.orderId)?.orderNumber ?? result.orderId}: {result.error}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
