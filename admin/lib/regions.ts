import { api } from './api';

export type Region = { id: string; code: string; name: string };
export type RegionCity = Region & { type: 'CITY' | 'REGENCY'; provinceId: string };
export type RegionDistrict = Region & { cityId: string };
export type RegionVillage = Region & { postalCode: string | null; districtId: string };

export function fetchProvinces() {
  return api<Region[]>('/regions/provinces?limit=100');
}

export function fetchCities(provinceId: string) {
  return api<RegionCity[]>(`/regions/cities?provinceId=${encodeURIComponent(provinceId)}&limit=500`);
}

export function fetchDistricts(cityId: string) {
  return api<RegionDistrict[]>(`/regions/districts?cityId=${encodeURIComponent(cityId)}&limit=500`);
}

export function fetchVillages(districtId: string) {
  return api<RegionVillage[]>(`/regions/villages?districtId=${encodeURIComponent(districtId)}&limit=500`);
}
