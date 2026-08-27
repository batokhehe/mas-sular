'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { RegionChainSelect, RegionSelection } from '@/components/coverage/region-chain-select';
import { AdminOutlet, OutletInput } from '@/lib/admin';

interface Props {
  initialValues?: AdminOutlet;
  onSubmit: (values: OutletInput) => Promise<void>;
  submitLabel: string;
  isSubmitting?: boolean;
}

const inputClass =
  'w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white';

export function OutletForm({ initialValues, onSubmit, submitLabel, isSubmitting }: Props) {
  const [name, setName] = useState(initialValues?.name ?? '');
  const [addressDetail, setAddressDetail] = useState(initialValues?.addressDetail ?? '');
  const [region, setRegion] = useState<RegionSelection>({
    provinceId: initialValues?.provinceId ?? '',
    cityId: initialValues?.cityId ?? '',
    districtId: initialValues?.districtId ?? '',
    villageId: initialValues?.villageId ?? '',
  });
  const [postalCode, setPostalCode] = useState(initialValues?.postalCode ?? '');
  const [latitude, setLatitude] = useState<string>(
    initialValues?.latitude != null ? String(initialValues.latitude) : '',
  );
  const [longitude, setLongitude] = useState<string>(
    initialValues?.longitude != null ? String(initialValues.longitude) : '',
  );
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (!name.trim()) return setError('Outlet name is required.');
    if (!/^\d{5}$/.test(postalCode)) return setError('Postal code must be exactly 5 digits.');
    const lat = Number(latitude);
    const lng = Number(longitude);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) return setError('Latitude must be between -90 and 90.');
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) return setError('Longitude must be between -180 and 180.');

    await onSubmit({
      name: name.trim(),
      addressDetail: addressDetail.trim() || undefined,
      provinceId: region.provinceId || null,
      cityId: region.cityId || null,
      districtId: region.districtId || null,
      villageId: region.villageId || null,
      postalCode,
      latitude: lat,
      longitude: lng,
    });
  };

  return (
    <Card>
      <CardTitle>{submitLabel}</CardTitle>
      <form onSubmit={handleSubmit} className="mt-4 space-y-6">
        <div className="grid gap-4 lg:grid-cols-2">
          <label className="space-y-2 text-sm text-gray-700">
            <span>Outlet Name *</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} required />
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Address (street, no.)</span>
            <input value={addressDetail} onChange={(e) => setAddressDetail(e.target.value)} className={inputClass} />
          </label>
        </div>

        <div>
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-400">Region</p>
          <RegionChainSelect value={region} onChange={setRegion} />
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <label className="space-y-2 text-sm text-gray-700">
            <span>Postal Code *</span>
            <input
              value={postalCode}
              onChange={(e) => setPostalCode(e.target.value.replace(/\D/g, '').slice(0, 5))}
              className={inputClass}
              inputMode="numeric"
              required
            />
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Latitude *</span>
            <input
              value={latitude}
              onChange={(e) => setLatitude(e.target.value)}
              className={inputClass}
              placeholder="-6.9147"
              required
            />
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Longitude *</span>
            <input
              value={longitude}
              onChange={(e) => setLongitude(e.target.value)}
              className={inputClass}
              placeholder="107.6098"
              required
            />
          </label>
        </div>

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
