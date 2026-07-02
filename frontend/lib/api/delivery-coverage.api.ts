import { api } from './client'

export type CoverageType = 'DELIVERY' | 'PICKUP_ONLY' | 'DISABLED'

export interface CoverageCheckResult {
  configured: boolean
  coverageId: string | null
  coverageType: CoverageType
  deliveryFee: number
  minimumOrder: number
  estimatedMinutes: number | null
  deliverable: boolean
  pickupOnly: boolean
}

export interface CoverageCheckParams {
  provinceId: string
  cityId: string
  districtId?: string | null
  villageId?: string | null
}

function qs(params: CoverageCheckParams): string {
  const sp = new URLSearchParams()
  sp.set('provinceId', params.provinceId)
  sp.set('cityId', params.cityId)
  if (params.districtId) sp.set('districtId', params.districtId)
  if (params.villageId) sp.set('villageId', params.villageId)
  return sp.toString()
}

export const deliveryCoverageApi = {
  check: (params: CoverageCheckParams) =>
    api.get<CoverageCheckResult>(`/delivery-coverage/check?${qs(params)}`, 'public'),
}
