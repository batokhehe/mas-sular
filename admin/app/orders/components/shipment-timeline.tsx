'use client';

// Canonical forward lifecycle shown as a timeline.
const STEPS: { status: string; label: string }[] = [
  { status: 'CREATED', label: 'Created' },
  { status: 'PICKED_UP', label: 'Picked Up' },
  { status: 'IN_TRANSIT', label: 'In Transit' },
  { status: 'OUT_FOR_DELIVERY', label: 'Out For Delivery' },
  { status: 'DELIVERED', label: 'Delivered' },
];

const ORDER = STEPS.map((s) => s.status);

interface HistoryEntry {
  mappedStatus: string;
  changedAt: string;
}

interface Props {
  currentStatus: string;
  history?: HistoryEntry[];
}

/**
 * Vertical shipment timeline. A step is "reached" when the current status is at or
 * past it, or it appears in the recorded history. FAILED/CANCELLED are surfaced as
 * a terminal note rather than a step.
 */
export function ShipmentTimeline({ currentStatus, history = [] }: Props) {
  const reachedFromHistory = new Set(history.map((h) => h.mappedStatus));
  const currentIndex = ORDER.indexOf(currentStatus);
  const changedAtByStatus = new Map(history.map((h) => [h.mappedStatus, h.changedAt]));

  const isReached = (status: string, index: number) =>
    reachedFromHistory.has(status) || (currentIndex >= 0 && index <= currentIndex);

  const terminal = currentStatus === 'FAILED' || currentStatus === 'CANCELLED';

  return (
    <div className="mt-3">
      <p className="text-xs uppercase text-gray-400">Shipment Timeline</p>
      <ol className="mt-3 space-y-0">
        {STEPS.map((step, index) => {
          const reached = isReached(step.status, index);
          const changedAt = changedAtByStatus.get(step.status);
          const last = index === STEPS.length - 1;
          return (
            <li key={step.status} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span
                  className={[
                    'flex h-4 w-4 items-center justify-center rounded-full border',
                    reached ? 'border-[#465fff] bg-[#465fff]' : 'border-gray-300 bg-white',
                  ].join(' ')}
                />
                {!last ? <span className={['w-px flex-1', reached ? 'bg-[#465fff]' : 'bg-gray-200'].join(' ')} style={{ minHeight: 20 }} /> : null}
              </div>
              <div className="pb-4">
                <p className={reached ? 'text-sm font-medium text-gray-900' : 'text-sm text-gray-400'}>{step.label}</p>
                {changedAt ? (
                  <p className="text-xs text-gray-400">{new Date(changedAt).toLocaleString('id-ID')}</p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {terminal ? (
        <p className={`text-sm font-medium ${currentStatus === 'FAILED' ? 'text-red-600' : 'text-gray-600'}`}>
          Shipment {currentStatus === 'FAILED' ? 'failed' : 'cancelled'}.
        </p>
      ) : null}
    </div>
  );
}
