'use client'

import { useQuery } from '@tanstack/react-query'
import { regionsApi } from '@/lib/api/regions.api'
import { qk } from '@/lib/query/keys'

// Master data is effectively static within a session — cache generously.
const STALE = 1000 * 60 * 30

export function useProvinces(search: string) {
  return useQuery({
    queryKey: qk.regions.provinces(search),
    queryFn: () => regionsApi.provinces({ search, limit: 100 }),
    staleTime: STALE,
  })
}

export function useCities(provinceId: string | undefined, search: string) {
  return useQuery({
    queryKey: qk.regions.cities(provinceId ?? '', search),
    queryFn: () => regionsApi.cities(provinceId as string, { search, limit: 200 }),
    enabled: !!provinceId,
    staleTime: STALE,
  })
}

export function useDistricts(cityId: string | undefined, search: string) {
  return useQuery({
    queryKey: qk.regions.districts(cityId ?? '', search),
    queryFn: () => regionsApi.districts(cityId as string, { search, limit: 200 }),
    enabled: !!cityId,
    staleTime: STALE,
  })
}

export function useVillages(districtId: string | undefined, search: string) {
  return useQuery({
    queryKey: qk.regions.villages(districtId ?? '', search),
    queryFn: () => regionsApi.villages(districtId as string, { search, limit: 300 }),
    enabled: !!districtId,
    staleTime: STALE,
  })
}
