'use client'

import { useEffect, useRef } from 'react'
import Script from 'next/script'

// Minimal typing for the Google Identity Services client we use.
interface CredentialResponse {
  credential?: string
}
interface GoogleIdentity {
  accounts: {
    id: {
      initialize: (config: {
        client_id: string
        callback: (response: CredentialResponse) => void
      }) => void
      renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void
    }
  }
}

function getGoogle(): GoogleIdentity | undefined {
  return (window as unknown as { google?: GoogleIdentity }).google
}

interface Props {
  onCredential: (idToken: string) => void
  onError?: () => void
}

/**
 * Renders the Google Identity Services button. On a successful sign-in the
 * Google ID token (`credential`) is handed to `onCredential`, which the login
 * page forwards to the backend `POST /auth/google` via AuthProvider.
 */
export function GoogleSignInButton({ onCredential, onError }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const renderedRef = useRef(false)
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID

  const renderButton = () => {
    const google = getGoogle()
    if (!google || !containerRef.current || !clientId || renderedRef.current) return
    google.accounts.id.initialize({
      client_id: clientId,
      callback: (response) => {
        if (response.credential) onCredential(response.credential)
        else onError?.()
      },
    })
    google.accounts.id.renderButton(containerRef.current, {
      theme: 'outline',
      size: 'large',
      width: 320,
      text: 'continue_with',
      shape: 'pill',
    })
    renderedRef.current = true
  }

  // Handle the case where the GSI script is already cached/loaded.
  useEffect(() => {
    if (getGoogle()) renderButton()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!clientId) {
    return (
      <p className="text-sm text-destructive">
        Google sign-in is not configured (NEXT_PUBLIC_GOOGLE_CLIENT_ID missing).
      </p>
    )
  }

  return (
    <>
      <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" onLoad={renderButton} />
      <div ref={containerRef} className="flex justify-center" />
    </>
  )
}
