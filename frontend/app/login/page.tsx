'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuthStore, useAddressStore } from '@/lib/store'

export default function LoginPage() {
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(false)
  const login = useAuthStore((state) => state.login)
  const { isOnboarded } = useAuthStore()
  const addresses = useAddressStore((state) => state.addresses)

  const handleGoogleLogin = async () => {
    setIsLoading(true)

    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID

    // If a Google client id isn't configured, fall back to the simulated flow
    if (!clientId || typeof window === 'undefined' || !(window as any).google) {
      // Simulate OAuth login
      await new Promise((resolve) => setTimeout(resolve, 1500))
      login({
        id: '1',
        name: 'John Doe',
        email: 'john.doe@gmail.com',
        avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=john',
      })
      setIsLoading(false)
      if (!isOnboarded || addresses.length === 0) router.push('/onboarding')
      else router.push('/')
      return
    }

    try {
      // Trigger Google ID token prompt (One Tap / popup)
      ;(window as any).google.accounts.id.prompt()
      // The callback installed during initialize will handle the response
    } catch (err) {
      console.error('Google login error', err)
      setIsLoading(false)
    }
  }

  // Initialize Google ID token flow and handle credential response
  useEffect(() => {
    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID
    if (!clientId) return

    const handleCredentialResponse = async (response: any) => {
      try {
        const idToken = response?.credential
        if (!idToken) throw new Error('No ID token from Google')

        // Send ID token to backend for verification and token minting
        const res = await fetch(`${process.env.NEXT_PUBLIC_API_BASE ?? '/api'}/v1/auth/google`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
        })
        if (!res.ok) throw new Error('Auth endpoint returned error')
        const tokens = await res.json()

        // Store tokens locally (consider secure cookie/httpOnly in production)
        try { localStorage.setItem('accessToken', tokens.accessToken) } catch {}
        try { localStorage.setItem('refreshToken', tokens.refreshToken) } catch {}

        // Fetch user profile from backend using the new access token
        const me = await fetch(`${process.env.NEXT_PUBLIC_API_BASE ?? '/api'}/v1/users/me`, {
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
        })
        if (!me.ok) throw new Error('Failed to fetch user profile')
        const user = await me.json()

        // Map user to local store and redirect
        login({ id: user.id, name: user.name, email: user.email, avatar: user.avatarUrl })
        setIsLoading(false)
        if (!user.isOnboarded || (user.addresses || []).length === 0) router.push('/onboarding')
        else router.push('/')
      } catch (e) {
        console.error('Google credential handling failed', e)
        setIsLoading(false)
      }
    }

    // Load GIS script if not present
    if (!(window as any).google) {
      const s = document.createElement('script')
      s.src = 'https://accounts.google.com/gsi/client'
      s.async = true
      s.defer = true
      document.head.appendChild(s)
      s.onload = () => {
        (window as any).google.accounts.id.initialize({
          client_id: clientId,
          callback: handleCredentialResponse,
          ux_mode: 'popup',
        })
      }
    } else {
      (window as any).google.accounts.id.initialize({
        client_id: clientId,
        callback: handleCredentialResponse,
        ux_mode: 'popup',
      })
    }

    return () => {
      // no-op cleanup
    }
  }, [login, router])

  return (
    <div className="min-h-screen flex">
      {/* Left Side - Branding (Desktop) */}
      <div className="hidden lg:flex lg:w-1/2 bg-primary relative overflow-hidden">
        <div className="absolute inset-0 bg-[url('data:image/svg+xml,%3Csvg%20width%3D%2260%22%20height%3D%2260%22%20viewBox%3D%220%200%2060%2060%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cg%20fill%3D%22none%22%20fill-rule%3D%22evenodd%22%3E%3Cg%20fill%3D%22%23ffffff%22%20fill-opacity%3D%220.1%22%3E%3Cpath%20d%3D%22M36%2034v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6%2034v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6%204V0H4v4H0v2h4v4h2V6h4V4H6z%22%2F%3E%3C%2Fg%3E%3C%2Fg%3E%3C%2Fsvg%3E')] opacity-30" />
        
        <div className="relative z-10 flex flex-col justify-center px-12 xl:px-20 text-primary-foreground">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
          >
            <div className="flex items-center gap-3 mb-8">
              <div className="h-12 w-12 rounded-xl bg-primary-foreground/20 flex items-center justify-center text-2xl font-bold">
                BN
              </div>
              <span className="text-2xl font-bold">Baso Nusantara</span>
            </div>

            <h1 className="text-4xl xl:text-5xl font-bold leading-tight mb-4">
              Bakso Premium<br />
              Langsung ke<br />
              Rumah Anda
            </h1>

            <p className="text-lg opacity-90 max-w-md">
              Nikmati kelezatan bakso autentik Indonesia dengan bahan berkualitas tinggi, 
              diantar segar ke pintu rumah Anda.
            </p>

            {/* Features */}
            <div className="grid grid-cols-3 gap-6 mt-12">
              {[
                { value: '50K+', label: 'Pelanggan Puas' },
                { value: '30 min', label: 'Pengiriman Cepat' },
                { value: '4.9', label: 'Rating Aplikasi' },
              ].map((stat) => (
                <div key={stat.label}>
                  <p className="text-2xl font-bold">{stat.value}</p>
                  <p className="text-sm opacity-80">{stat.label}</p>
                </div>
              ))}
            </div>
          </motion.div>
        </div>

        {/* Decorative elements */}
        <div className="absolute -bottom-20 -right-20 w-80 h-80 rounded-full bg-primary-foreground/10" />
        <div className="absolute top-20 -right-10 w-40 h-40 rounded-full bg-primary-foreground/5" />
      </div>

      {/* Right Side - Login Form */}
      <div className="flex-1 flex items-center justify-center p-6 lg:p-12">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-md"
        >
          {/* Mobile Logo */}
          <div className="lg:hidden text-center mb-8">
            <div className="inline-flex items-center gap-2 mb-4">
              <div className="h-10 w-10 rounded-xl bg-primary text-primary-foreground flex items-center justify-center text-lg font-bold">
                BN
              </div>
              <span className="text-xl font-bold">Baso Nusantara</span>
            </div>
          </div>

          <div className="text-center lg:text-left mb-8">
            <h2 className="text-2xl lg:text-3xl font-bold mb-2">
              Selamat Datang!
            </h2>
            <p className="text-muted-foreground">
              Masuk untuk mulai memesan bakso favorit Anda
            </p>
          </div>

          {/* Google Login Button */}
          <Button
            variant="outline"
            size="lg"
            className="w-full rounded-full h-12 text-base"
            onClick={handleGoogleLogin}
            disabled={isLoading}
          >
            {isLoading ? (
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            ) : (
              <svg className="mr-2 h-5 w-5" viewBox="0 0 24 24">
                <path
                  fill="currentColor"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="currentColor"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="currentColor"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                />
                <path
                  fill="currentColor"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                />
              </svg>
            )}
            {isLoading ? 'Memproses...' : 'Lanjutkan dengan Google'}
          </Button>

          <p className="text-center text-sm text-muted-foreground mt-6">
            Dengan masuk, Anda menyetujui{' '}
            <Link href="#" className="text-primary hover:underline">
              Syarat & Ketentuan
            </Link>{' '}
            dan{' '}
            <Link href="#" className="text-primary hover:underline">
              Kebijakan Privasi
            </Link>{' '}
            kami.
          </p>

          {/* Back to Home */}
          <div className="text-center mt-8">
            <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
              Kembali ke Beranda
            </Link>
          </div>
        </motion.div>
      </div>
    </div>
  )
}
