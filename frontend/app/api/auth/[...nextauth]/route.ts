import NextAuth, { type NextAuthOptions } from "next-auth"
import GoogleProvider from "next-auth/providers/google"

const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.NEXTAUTH_GOOGLE_CLIENT_ID || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.NEXTAUTH_GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || "",
    }),
  ],
  callbacks: {
    async signIn({ account }) {
      // After successful provider sign-in, send the Google id_token to backend to mint app tokens
      try {
        const idToken = (account as { id_token?: string } | null)?.id_token
        if (!idToken) return true // allow fallback; backend verification handled elsewhere

        const res = await fetch(`${process.env.NEXT_PUBLIC_API_BASE ?? '/api'}/v1/auth/google`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
        })
        if (!res.ok) return false
        const tokens = (await res.json()) as { accessToken?: string; refreshToken?: string }
        // Attach minted tokens to account so the jwt callback can persist them
        if (account) {
          ;(account as Record<string, unknown>).appAccessToken = tokens.accessToken
          ;(account as Record<string, unknown>).appRefreshToken = tokens.refreshToken
        }
        return true
      } catch (e) {
        console.error('Error calling backend auth/google', e)
        return false
      }
    },
    async jwt({ token, account }) {
      // Persist app tokens in the JWT
      if (account) {
        const acc = account as Record<string, unknown>
        if (acc.appAccessToken) token.appAccessToken = acc.appAccessToken
        if (acc.appRefreshToken) token.appRefreshToken = acc.appRefreshToken
      }
      return token
    },
    async session({ session, token }) {
      // Expose app tokens to the client session object
      ;(session as unknown as Record<string, unknown>).appAccessToken = (token as Record<string, unknown>).appAccessToken
      ;(session as unknown as Record<string, unknown>).appRefreshToken = (token as Record<string, unknown>).appRefreshToken
      return session
    },
  },
}

// App Router NextAuth handler — must be exported as GET/POST route handlers.
const handler = NextAuth(authOptions)
export { handler as GET, handler as POST }
