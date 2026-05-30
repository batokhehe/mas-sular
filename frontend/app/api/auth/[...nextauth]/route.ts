import NextAuth from "next-auth"
import GoogleProvider from "next-auth/providers/google"

export const authOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.NEXTAUTH_GOOGLE_CLIENT_ID || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
      clientSecret: process.env.NEXTAUTH_GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET,
    }),
  ],
  callbacks: {
    async signIn({ account }) {
      // After successful provider sign-in, send the Google id_token to backend to mint app tokens
      try {
        const idToken = (account as any)?.id_token
        if (!idToken) return true // allow fallback; backend verification handled elsewhere

        const res = await fetch(`${process.env.NEXT_PUBLIC_API_BASE ?? '/api'}/v1/auth/google`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
        })
        if (!res.ok) return false
        const tokens = await res.json()
        // Attach minted tokens to account so jwt callback can persist them
        ;(account as any).appAccessToken = tokens.accessToken
        ;(account as any).appRefreshToken = tokens.refreshToken
        return true
      } catch (e) {
        console.error('Error calling backend auth/google', e)
        return false
      }
    },
    async jwt({ token, account }) {
      // Persist app tokens in the JWT
      if (account) {
        if ((account as any).appAccessToken) token.appAccessToken = (account as any).appAccessToken
        if ((account as any).appRefreshToken) token.appRefreshToken = (account as any).appRefreshToken
      }
      return token
    },
    async session({ session, token }) {
      // Expose app tokens to the client session object
      (session as any).appAccessToken = (token as any).appAccessToken
      (session as any).appRefreshToken = (token as any).appRefreshToken
      return session
    },
  },
}

export { NextAuth }
export default NextAuth(authOptions)
