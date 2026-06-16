'use client'

import { useState, type ReactNode } from 'react'
import {
  QueryClient,
  QueryClientProvider,
  QueryCache,
  MutationCache,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api/client'

// Background query failures surface a toast; mutation errors are handled inline
// by the caller but also toast as a fallback. Auth refresh/redirect is handled
// in the API client, so 401s here mean the refresh already failed.
function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return 'You do not have permission to do that.'
    if (error.status === 404) return 'Not found.'
    if (error.status === 429) return 'Too many requests — please slow down.'
    if (error.status >= 500) return 'Something went wrong on our end. Please try again.'
    return error.message
  }
  return error instanceof Error ? error.message : 'Unexpected error'
}

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          // Never retry auth/permission/not-found; retry transient/server errors once.
          if (error instanceof ApiError && [401, 403, 404, 422].includes(error.status)) return false
          return failureCount < 1
        },
      },
      mutations: { retry: 0 },
    },
    queryCache: new QueryCache({
      onError: (error) => toast.error(messageFor(error)),
    }),
    mutationCache: new MutationCache({
      onError: (error) => toast.error(messageFor(error)),
    }),
  })
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => makeQueryClient())
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
