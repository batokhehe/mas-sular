import { api } from './client'
import type { Banner } from '@/lib/types/models'

export const cmsApi = {
  // Public marketing banners. Optionally filtered by placement (free-form string
  // on the backend; the server filters isActive + not-deleted and sorts by sortOrder).
  banners: (placement?: string) =>
    api.get<Banner[]>(`/cms/banners${placement ? `?placement=${encodeURIComponent(placement)}` : ''}`),
}
