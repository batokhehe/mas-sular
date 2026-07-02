'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { RegionChainSelect, RegionSelection } from '@/components/coverage/region-chain-select';
import { AdminDeliveryCoverage, CoverageType, DeliveryCoverageInput } from '@/lib/admin';

interface Props {
  initialValues?: AdminDeliveryCoverage;
  onSubmit: (values: DeliveryCoverageInput) => Promise<void>;
  submitLabel: string;
  isSubmitting?: boolean;
}

const coverageTypeOptions: { value: CoverageType; label: string }[] = [
  { value: 'DELIVERY', label: 'Delivery' },
  { value: 'PICKUP_ONLY', label: 'Pickup Only' },
  { value: 'DISABLED', label: 'Disabled' },
];

const inputClass =
  'w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white';

export function CoverageForm({ initialValues, onSubmit, submitLabel, isSubmitting }: Props) {
  const [region, setRegion] = useState<RegionSelection>({
    provinceId: initialValues?.provinceId ?? '',
    cityId: initialValues?.cityId ?? '',
    districtId: initialValues?.districtId ?? '',
    villageId: initialValues?.villageId ?? '',
  });
  const [coverageType, setCoverageType] = useState<CoverageType>(initialValues?.coverageType ?? 'DELIVERY');
  const [deliveryFee, setDeliveryFee] = useState<number>(initialValues?.deliveryFee ?? 0);
  const [minimumOrder, setMinimumOrder] = useState<number>(initialValues?.minimumOrder ?? 0);
  const [estimatedMinutes, setEstimatedMinutes] = useState<number>(initialValues?.estimatedMinutes ?? 60);
  const [isActive, setIsActive] = useState<boolean>(initialValues?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (!region.provinceId || !region.cityId) {
      setError('Province and City are required.');
      return;
    }
    if (deliveryFee < 0) return setError('Delivery fee must be >= 0.');
    if (minimumOrder < 0) return setError('Minimum order must be >= 0.');
    if (estimatedMinutes <= 0) return setError('Estimated minutes must be > 0.');

    await onSubmit({
      provinceId: region.provinceId,
      cityId: region.cityId,
      districtId: region.districtId || null,
      villageId: region.villageId || null,
      coverageType,
      deliveryFee,
      minimumOrder,
      estimatedMinutes,
      isActive,
    });
  };

  return (
    <Card>
      <CardTitle>{submitLabel}</CardTitle>
      <form onSubmit={handleSubmit} className="mt-4 space-y-6">
        <div>
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-400">Coverage Area</p>
          <RegionChainSelect value={region} onChange={setRegion} />
          <p className="mt-2 text-xs text-gray-500">
            Leave District/Village empty to apply the rule at a broader level. More specific rules take priority.
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <label className="space-y-2 text-sm text-gray-700">
            <span>Coverage Type *</span>
            <select
              value={coverageType}
              onChange={(e) => setCoverageType(e.target.value as CoverageType)}
              className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm outline-none focus:border-[#465fff]"
            >
              {coverageTypeOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-2 text-sm text-gray-700">
            <span>Delivery Fee (Rp)</span>
            <input
              type="number"
              min={0}
              value={deliveryFee}
              onChange={(e) => setDeliveryFee(Number(e.target.value))}
              className={inputClass}
              disabled={coverageType !== 'DELIVERY'}
            />
          </label>

          <label className="space-y-2 text-sm text-gray-700">
            <span>Minimum Order (Rp)</span>
            <input
              type="number"
              min={0}
              value={minimumOrder}
              onChange={(e) => setMinimumOrder(Number(e.target.value))}
              className={inputClass}
              disabled={coverageType !== 'DELIVERY'}
            />
          </label>

          <label className="space-y-2 text-sm text-gray-700">
            <span>Estimated Delivery (minutes)</span>
            <input
              type="number"
              min={1}
              value={estimatedMinutes}
              onChange={(e) => setEstimatedMinutes(Number(e.target.value))}
              className={inputClass}
            />
          </label>
        </div>

        <label className="flex items-center gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-[#465fff] focus:ring-[#465fff]"
          />
          <span>Active</span>
        </label>

        {error ? <p className="text-sm text-red-600">{error}</p> : null}

        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={isSubmitting}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Card>
  );
}
