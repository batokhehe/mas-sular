import { api } from './client'
import type { Address } from '@/lib/types/models'

export interface AddressInput {
  label: string
  recipientName: string
  phone: string
  fullAddress: string
  notes?: string
  latitude: number
  longitude: number
  isDefault: boolean
  // Indonesian administrative hierarchy (optional — backward compatible).
  addressDetail?: string
  provinceId?: string
  cityId?: string
  districtId?: string
  villageId?: string
  postalCode?: string
}

export type AddressUpdate = Partial<AddressInput>

export const addressesApi = {
  list: () => api.get<Address[]>('/users/me/addresses', 'customer'),
  create: (body: AddressInput) => api.post<Address>('/users/me/addresses', body, 'customer'),
  update: (id: string, body: AddressUpdate) =>
    api.patch<Address>(`/users/me/addresses/${id}`, body, 'customer'),
  remove: (id: string) => api.del<{ success: boolean }>(`/users/me/addresses/${id}`, 'customer'),
}
