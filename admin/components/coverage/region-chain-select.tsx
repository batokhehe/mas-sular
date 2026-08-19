'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchCities, fetchDistricts, fetchProvinces, fetchVillages } from '@/lib/regions';

export type RegionSelection = {
  provinceId: string;
  cityId: string;
  districtId: string;
  villageId: string;
};

interface Props {
  value: RegionSelection;
  onChange: (next: RegionSelection) => void;
}

const selectClass =
  'w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm outline-none focus:border-[#465fff] disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400';

/**
 * Province → City → District → Village chain-select for coverage rules. Loading is
 * progressive (each level fetches only once its parent is chosen) and selecting a
 * higher level cascades a reset of every lower level. District and Village are
 * optional (leaving them empty makes the rule apply at the city/district level).
 */
export function RegionChainSelect({ value, onChange }: Props) {
  const provinces = useQuery({ queryKey: ['regions', 'provinces'], queryFn: fetchProvinces, staleTime: 1000 * 60 * 30 });
  const cities = useQuery({
    queryKey: ['regions', 'cities', value.provinceId],
    queryFn: () => fetchCities(value.provinceId),
    enabled: !!value.provinceId,
    staleTime: 1000 * 60 * 30,
  });
  const districts = useQuery({
    queryKey: ['regions', 'districts', value.cityId],
    queryFn: () => fetchDistricts(value.cityId),
    enabled: !!value.cityId,
    staleTime: 1000 * 60 * 30,
  });
  const villages = useQuery({
    queryKey: ['regions', 'villages', value.districtId],
    queryFn: () => fetchVillages(value.districtId),
    enabled: !!value.districtId,
    staleTime: 1000 * 60 * 30,
  });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <label className="space-y-2 text-sm text-gray-700">
        <span>Province *</span>
        <select
          value={value.provinceId}
          onChange={(e) => onChange({ provinceId: e.target.value, cityId: '', districtId: '', villageId: '' })}
          className={selectClass}
          required
        >
          <option value="">{provinces.isLoading ? 'Loading…' : 'Select province'}</option>
          {(provinces.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      <label className="space-y-2 text-sm text-gray-700">
        <span>City / Regency *</span>
        <select
          value={value.cityId}
          onChange={(e) => onChange({ ...value, cityId: e.target.value, districtId: '', villageId: '' })}
          className={selectClass}
          disabled={!value.provinceId}
          required
        >
          <option value="">{cities.isFetching ? 'Loading…' : 'Select city/regency'}</option>
          {(cities.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      <label className="space-y-2 text-sm text-gray-700">
        <span>District (optional)</span>
        <select
          value={value.districtId}
          onChange={(e) => onChange({ ...value, districtId: e.target.value, villageId: '' })}
          className={selectClass}
          disabled={!value.cityId}
        >
          <option value="">{districts.isFetching ? 'Loading…' : 'All districts'}</option>
          {(districts.data ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>

      <label className="space-y-2 text-sm text-gray-700">
        <span>Village (optional)</span>
        <select
          value={value.villageId}
          onChange={(e) => onChange({ ...value, villageId: e.target.value })}
          className={selectClass}
          disabled={!value.districtId}
        >
          <option value="">{villages.isFetching ? 'Loading…' : 'All villages'}</option>
          {(villages.data ?? []).map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
              {v.postalCode ? ` (${v.postalCode})` : ''}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
