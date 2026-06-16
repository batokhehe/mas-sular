'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { AlertCircle, Loader2 } from 'lucide-react'
import { useAuth } from '@/lib/auth/auth-context'
import { GoogleSignInButton } from '@/components/auth/google-sign-in-button'
import { Card } from '@/components/ui/card'

function safeRedirect(value: string | null): string {
  // Only allow internal paths (avoid open redirects).
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/'
}

function LoginInner() {
  const router = useRouter()
  const params = useSearchParams()
  const redirect = safeRedirect(params.get('redirect'))
  const { loginWithGoogle, isAuthenticated } = useAuth()
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (isAuthenticated) router.replace(redirect)
  }, [isAuthenticated, redirect, router])

  const handleCredential = async (idToken: string) => {
    setError(null)
    setLoading(true)
    try {
      await loginWithGoogle(idToken)
      router.replace(redirect)
    } catch {
      setError('Login failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4">
      <Card className="space-y-6 p-8 text-center">
        <div>
          <h1 className="text-2xl font-bold">Welcome to Baso Nusantara</h1>
          <p className="mt-1 text-sm text-muted-foreground">Sign in to order and track your meatballs.</p>
        </div>

        {error ? (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="size-4" />
            <span>{error}</span>
          </div>
        ) : null}

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-3 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Signing in…
          </div>
        ) : (
          <GoogleSignInButton
            onCredential={handleCredential}
            onError={() => setError('Google sign-in was cancelled or failed.')}
          />
        )}

        <p className="text-xs text-muted-foreground">
          By continuing you agree to our terms of service.
        </p>
      </Card>
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
