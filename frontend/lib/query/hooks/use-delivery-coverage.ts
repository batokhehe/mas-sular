'use client'

import { useQuery } from '@tanstack/react-query'
import { deliveryCoverageApi } from '@/lib/api/delivery-coverage.api'
import { qk } from '@/lib/query/keys'
import type { Address } from '@/lib/types/models'

/**
 * Checks delivery coverage for the selected address. Only runs when the address
 * carries the administrative hierarchy (province + city). Legacy addresses (null
 * region ids) return `undefined` here → the caller keeps the legacy delivery flow.
 */
export function useCoverageCheck(address: Address | undefined) {
  const provinceId = address?.provinceId ?? ''
  const cityId = address?.cityId ?? ''
  const districtId = address?.districtId ?? ''
  const villageId = address?.villageId ?? ''
  const enabled = !!provinceId && !!cityId

  return useQuery({
    queryKey: qk.deliveryCoverage(provinceId, cityId, districtId, villageId),
    queryFn: () =>
      deliveryCoverageApi.check({
        provinceId,
        cityId,
        districtId: districtId || undefined,
        villageId: villageId || undefined,
      }),
    enabled,
    staleTime: 1000 * 60 * 5,
  })
}
