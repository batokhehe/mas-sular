'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Loader2 } from 'lucide-react'
import { useAuth } from '@/lib/auth/auth-context'
import { GoogleSignInButton } from '@/components/auth/google-sign-in-button'
import { qk } from '@/lib/query/keys'
import type { User } from '@/lib/types/models'

function safeRedirect(value: string | null): string {
  // Only allow internal paths (avoid open redirects).
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/'
}

function LoginInner() {
  const router = useRouter()
  const params = useSearchParams()
  const redirect = safeRedirect(params.get('redirect'))
  const qc = useQueryClient()
  const { loginWithGoogle, isAuthenticated } = useAuth()
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // A newly-authenticated user that hasn't completed onboarding is routed to
  // /onboarding (forwarding the original redirect). isOnboarded is read from the
  // qk.me cache, which loginWithGoogle populates synchronously via setQueryData —
  // so it is fresh here (no refetch race). AuthProvider is not modified.
  const destinationFor = useCallback((): string => {
    const me = qc.getQueryData<User>(qk.me)
    return me && me.isOnboarded === false
      ? `/onboarding?redirect=${encodeURIComponent(redirect)}`
      : redirect
  }, [qc, redirect])

  useEffect(() => {
    if (isAuthenticated) router.replace(destinationFor())
  }, [isAuthenticated, destinationFor, router])

  const handleCredential = async (idToken: string) => {
    setError(null)
    setLoading(true)
    try {
      await loginWithGoogle(idToken)
      router.replace(destinationFor())
    } catch {
      setError('Login failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen">
      {/* Left branding panel (desktop) — marketing copy only, no statistics */}
      <div className="relative hidden w-1/2 overflow-hidden bg-primary lg:flex">
        <div className="relative z-10 flex flex-col justify-center px-12 text-primary-foreground xl:px-20">
          <div className="mb-8 flex items-center gap-3">
            <span className="flex size-12 items-center justify-center rounded-xl bg-primary-foreground/20 text-2xl font-bold">
              BMS
            </span>
            <span className="text-2xl font-bold">Bakso Mas Sular</span>
          </div>

          <h1 className="mb-4 text-4xl font-bold leading-tight xl:text-5xl">
            Bakso Premium
            <br />
            Langsung ke
            <br />
            Rumah Anda
          </h1>

          <p className="max-w-md text-lg opacity-90">
            Nikmati kelezatan bakso autentik Indonesia dengan bahan berkualitas tinggi, diantar segar ke pintu rumah Anda.
          </p>
        </div>

        {/* Decorative visuals */}
        <div className="absolute -bottom-20 -right-20 size-80 rounded-full bg-primary-foreground/10" />
        <div className="absolute -right-10 top-20 size-40 rounded-full bg-primary-foreground/5" />
      </div>

      {/* Right login panel */}
      <div className="flex flex-1 items-center justify-center p-6 lg:p-12">
        <div className="w-full max-w-md">
          {/* Mobile brand */}
          <div className="mb-8 text-center lg:hidden">
            <div className="inline-flex items-center gap-2">
              <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-lg font-bold text-primary-foreground">
                BMS
              </span>
              <span className="text-xl font-bold">Bakso Mas Sular</span>
            </div>
          </div>

          <div className="mb-8 text-center lg:text-left">
            <h2 className="text-2xl font-bold lg:text-3xl">Welcome to Bakso Mas Sular</h2>
            <p className="mt-1 text-sm text-muted-foreground">Sign in to order and track your meatballs.</p>
          </div>

          {error ? (
            <div className="mb-6 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="size-4" />
              <span>{error}</span>
            </div>
          ) : null}

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-3 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Signing in…
            </div>
          ) : (
            <div className="flex justify-center lg:justify-start">
              <GoogleSignInButton
                onCredential={handleCredential}
                onError={() => setError('Google sign-in was cancelled or failed.')}
              />
            </div>
          )}

          <p className="mt-6 text-center text-xs text-muted-foreground lg:text-left">
            By continuing you agree to our terms of service.
          </p>
        </div>
      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center"><Loader2 className="size-6 animate-spin" /></div>}>
      <LoginInner />
    </Suspense>
  )
}
