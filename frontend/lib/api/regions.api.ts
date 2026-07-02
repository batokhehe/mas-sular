import { api } from './client'

export interface Province {
  id: string
  code: string
  name: string
  isActive: boolean
}

export interface City {
  id: string
  code: string
  name: string
  type: 'CITY' | 'REGENCY'
  provinceId: string
  isActive: boolean
}

export interface District {
  id: string
  code: string
  name: string
  cityId: string
  isActive: boolean
}

export interface Village {
  id: string
  code: string
  name: string
  postalCode: string | null
  districtId: string
  isActive: boolean
}

export interface RegionQuery {
  search?: string
  limit?: number
}

function qs(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '')
  if (entries.length === 0) return ''
  const sp = new URLSearchParams()
  for (const [k, v] of entries) sp.set(k, String(v))
  return `?${sp.toString()}`
}

/** Public master-address lookups. Loading is progressive — a level is fetched only
 *  once its parent id is known (see use-regions hooks). */
export const regionsApi = {
  provinces: (q: RegionQuery = {}) =>
    api.get<Province[]>(`/regions/provinces${qs({ ...q })}`, 'public'),
  cities: (provinceId: string, q: RegionQuery = {}) =>
    api.get<City[]>(`/regions/cities${qs({ provinceId, ...q })}`, 'public'),
  districts: (cityId: string, q: RegionQuery = {}) =>
    api.get<District[]>(`/regions/districts${qs({ cityId, ...q })}`, 'public'),
  villages: (districtId: string, q: RegionQuery = {}) =>
    api.get<Village[]>(`/regions/villages${qs({ districtId, ...q })}`, 'public'),
}
