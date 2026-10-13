/**
 * Production-readiness H2 — selector-based refresh tokens against REAL PostgreSQL
 * (the world applies every migration, including 20260911150000_add_refresh_token_selector).
 *
 * The old design bcrypt-compared the presented token against the newest 100 active
 * sessions (~250 ms each, synchronous): ~25 s of blocked event loop per bogus
 * refresh/logout, and sessions beyond the newest 100 could never refresh or be
 * revoked. These pin the replacement: one indexed lookup, one constant-time hash.
 */
import { randomUUID } from 'crypto'
import { UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import * as bcrypt from 'bcryptjs'
import { AuthService } from '../../src/modules/auth/auth.service'
import { getWorld, IntegrationWorld } from './world'

describe('H2 refresh tokens (real DB)', () => {
  let world: IntegrationWorld
  let auth: AuthService
  let userId: string
  const email = `rt-${randomUUID().slice(0, 8)}@example.test`

  beforeAll(async () => {
    process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? 'int-test-client-id'
    world = await getWorld()
    auth = new AuthService(world.prisma, new JwtService({ secret: 'int-test-access-secret-000000000000' }))
    const user = await world.prisma.user.create({ data: { email, name: 'Refresh Tester' } })
    userId = user.id
  })

  afterEach(() => jest.restoreAllMocks())

  const issue = () => auth.issueTokens(userId, email, ['CUSTOMER'])

  it('normal refresh rotates: the new token works, the old one is consumed', async () => {
    const first = await issue()
    const second = await auth.rotateRefreshToken(first.refreshToken)
    expect(second.refreshToken).not.toBe(first.refreshToken)

    await expect(auth.rotateRefreshToken(first.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException)
    const third = await auth.rotateRefreshToken(second.refreshToken)
    expect(third.accessToken).toEqual(expect.any(String))
  })

  it('the database never holds the token or its secret', async () => {
    const { refreshToken } = await issue()
    const [selector, secret] = refreshToken.split('.')
    const row = await world.prisma.refreshToken.findUnique({ where: { selector } })
    expect(row).not.toBeNull()
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(row)).not.toContain(secret)
  })

  it('logout revokes the session; a revoked token cannot refresh and a repeat logout is a no-op', async () => {
    const { refreshToken } = await issue()
    await auth.revokeRefreshToken(refreshToken)
    await expect(auth.rotateRefreshToken(refreshToken)).rejects.toBeInstanceOf(UnauthorizedException)
    await expect(auth.revokeRefreshToken(refreshToken)).resolves.toBeUndefined()
  })

  it('an expired session is rejected', async () => {
    const { refreshToken } = await issue()
    const selector = refreshToken.split('.')[0]
    await world.prisma.refreshToken.update({ where: { selector }, data: { expiresAt: new Date(Date.now() - 1000) } })
    await expect(auth.rotateRefreshToken(refreshToken)).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it('invalid tokens are rejected: garbage, wrong secret, unknown selector', async () => {
    const { refreshToken } = await issue()
    const [selector] = refreshToken.split('.')
    for (const bad of ['garbage', `${selector}.${'f'.repeat(64)}`, `${'a'.repeat(32)}.${'b'.repeat(64)}`]) {
      await expect(auth.rotateRefreshToken(bad)).rejects.toBeInstanceOf(UnauthorizedException)
    }
    // The real session is untouched by the failed attempts.
    await expect(auth.rotateRefreshToken(refreshToken)).resolves.toEqual(expect.objectContaining({ accessToken: expect.any(String) }))
  })

  it('concurrent refreshes with one token: exactly one rotation wins', async () => {
    const { refreshToken } = await issue()
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => auth.rotateRefreshToken(refreshToken)))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(4)
  })

  it('with 150 active sessions the OLDEST still refreshes and logs out, with no bcrypt and no scan', async () => {
    const oldest = await issue()
    const toRevoke = await issue()
    for (let i = 0; i < 148; i++) await issue() // push both well past the old 100-row window
    const active = await world.prisma.refreshToken.count({ where: { userId, revokedAt: null } })
    expect(active).toBeGreaterThanOrEqual(150)

    const compareSync = jest.spyOn(bcrypt, 'compareSync')
    const compare = jest.spyOn(bcrypt, 'compare')
    const findMany = jest.spyOn(world.prisma.refreshToken, 'findMany')

    const started = Date.now()
    await expect(auth.rotateRefreshToken(oldest.refreshToken)).resolves.toEqual(expect.objectContaining({ refreshToken: expect.any(String) }))
    await auth.revokeRefreshToken(toRevoke.refreshToken)
    await expect(auth.rotateRefreshToken(`${'c'.repeat(32)}.${'d'.repeat(64)}`)).rejects.toBeInstanceOf(UnauthorizedException)
    const elapsed = Date.now() - started

    expect(compareSync).not.toHaveBeenCalled()
    expect(compare).not.toHaveBeenCalled()
    expect(findMany).not.toHaveBeenCalled()
    // Three calls, each one indexed lookup + a hash - nothing like 100 x 250 ms.
    expect(elapsed).toBeLessThan(2000)
    await expect(auth.rotateRefreshToken(toRevoke.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it('a legacy (pre-H2) session cannot be presented any more; the customer signs in again', async () => {
    const legacyToken = randomUUID()
    await world.prisma.refreshToken.create({
      data: { userId, familyId: randomUUID(), tokenHash: bcrypt.hashSync(legacyToken, 4), expiresAt: new Date(Date.now() + 86_400_000) },
    })
    await expect(auth.rotateRefreshToken(legacyToken)).rejects.toBeInstanceOf(UnauthorizedException)
    await expect(auth.revokeRefreshToken(legacyToken)).resolves.toBeUndefined()
  })
})
