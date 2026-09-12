/**
 * Production-readiness B5 — the production bootstrap against a FRESH, migrated
 * PostgreSQL (each integration spec file boots its own world; nothing is seeded).
 */
import { JwtService } from '@nestjs/jwt'
import * as bcrypt from 'bcryptjs'
import { AdminAuthService } from '../../src/modules/admin-auth/admin-auth.service'
import { BootstrapError, bootstrapProduction, readBootstrapCredentials } from '../../prisma/bootstrap/production-bootstrap'
import { PERMISSIONS, ROLES } from '../../prisma/bootstrap/rbac'
import { getWorld, IntegrationWorld } from './world'

const OWNER = { BOOTSTRAP_ADMIN_EMAIL: 'owner@shop.example', BOOTSTRAP_ADMIN_PASSWORD: 'first-operator-passphrase-01', BOOTSTRAP_ADMIN_NAME: 'Pemilik' }

describe('B5 production bootstrap (real DB)', () => {
  let world: IntegrationWorld

  beforeAll(async () => {
    world = await getWorld()
  })

  const counts = async () => {
    const p = world.prisma
    const [roles, permissions, grants, admins, adminRoles, products, categories, toppings, promos, bankAccounts, outlets] = await Promise.all([
      p.role.count(), p.permission.count(), p.rolePermission.count(), p.admin.count(), p.adminRole.count(),
      p.product.count(), p.category.count(), p.topping.count(), p.promo.count(), p.paymentAccount.count(), p.outlet.count(),
    ])
    return { roles, permissions, grants, admins, adminRoles, products, categories, toppings, promos, bankAccounts, outlets }
  }

  it('starts from a fresh database with no admin, role or permission', async () => {
    expect(await counts()).toEqual({
      roles: 0, permissions: 0, grants: 0, admins: 0, adminRoles: 0,
      products: 0, categories: 0, toppings: 0, promos: 0, bankAccounts: 0, outlets: 0,
    })
  })

  it('creates the roles, the permissions, and the first Super Admin - and nothing else', async () => {
    const outcome = await bootstrapProduction(world.prisma, readBootstrapCredentials(OWNER))
    expect(outcome.admin).toBe('created')

    const c = await counts()
    expect(c.roles).toBe(ROLES.length)
    expect(c.permissions).toBe(PERMISSIONS.length)
    expect(c.grants).toBe(PERMISSIONS.length) // SUPER_ADMIN holds every permission
    expect(c.admins).toBe(1)
    expect(c.adminRoles).toBe(1)
    // No demo catalogue, voucher, bank account or outlet.
    expect({ products: c.products, categories: c.categories, toppings: c.toppings, promos: c.promos, bankAccounts: c.bankAccounts, outlets: c.outlets })
      .toEqual({ products: 0, categories: 0, toppings: 0, promos: 0, bankAccounts: 0, outlets: 0 })
    expect(await world.prisma.admin.findUnique({ where: { email: 'admin@test.com' } })).toBeNull()

    const admin = await world.prisma.admin.findUniqueOrThrow({ where: { email: 'owner@shop.example' }, include: { roles: { include: { role: true } } } })
    expect(admin.isActive).toBe(true)
    expect(admin.name).toBe('Pemilik')
    expect(admin.roles.map((r) => r.role.name)).toEqual(['SUPER_ADMIN'])
    expect(admin.passwordHash).not.toContain(OWNER.BOOTSTRAP_ADMIN_PASSWORD)
    expect(await bcrypt.compare(OWNER.BOOTSTRAP_ADMIN_PASSWORD, admin.passwordHash)).toBe(true)
  })

  it('the created admin can log in through the real admin auth service with full permissions', async () => {
    const auth = new AdminAuthService(world.prisma, new JwtService({ secret: 'int-test-admin-secret-00000000000000' }))
    const session = await auth.login('owner@shop.example', OWNER.BOOTSTRAP_ADMIN_PASSWORD)
    expect(session.accessToken).toEqual(expect.any(String))
    expect(session.permissions).toEqual(expect.arrayContaining(['Order.read', 'Order.update', 'Notification.send', 'Product.create']))
    await expect(auth.login('owner@shop.example', 'wrong-password-000')).rejects.toThrow()
  })

  it('a re-run is idempotent and never resets the existing password', async () => {
    const before = await world.prisma.admin.findUniqueOrThrow({ where: { email: 'owner@shop.example' } })
    const snapshot = await counts()

    // Same address, DIFFERENT password: must NOT be applied.
    const outcome = await bootstrapProduction(world.prisma, readBootstrapCredentials({ ...OWNER, BOOTSTRAP_ADMIN_PASSWORD: 'attempted-reset-passphrase-02', BOOTSTRAP_ADMIN_NAME: 'Renamed' }))
    expect(outcome.admin).toBe('unchanged')

    const after = await world.prisma.admin.findUniqueOrThrow({ where: { email: 'owner@shop.example' } })
    expect(after.passwordHash).toBe(before.passwordHash)
    expect(after.name).toBe(before.name)
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime())
    expect(await counts()).toEqual(snapshot)
  })

  it('an existing admin changed by the operator is preserved exactly (status, name, password)', async () => {
    const newHash = await bcrypt.hash('operator-rotated-passphrase-03', 4)
    await world.prisma.admin.update({ where: { email: 'owner@shop.example' }, data: { passwordHash: newHash, name: 'Operator Edited', isActive: false } })

    await bootstrapProduction(world.prisma, readBootstrapCredentials(OWNER))

    const admin = await world.prisma.admin.findUniqueOrThrow({ where: { email: 'owner@shop.example' } })
    expect(admin).toEqual(expect.objectContaining({ passwordHash: newHash, name: 'Operator Edited', isActive: false }))
    await world.prisma.admin.update({ where: { email: 'owner@shop.example' }, data: { isActive: true } })
  })

  it('refuses to create a SECOND Super Admin under a different address', async () => {
    const snapshot = await counts()
    await expect(
      bootstrapProduction(world.prisma, readBootstrapCredentials({ ...OWNER, BOOTSTRAP_ADMIN_EMAIL: 'intruder@shop.example' })),
    ).rejects.toBeInstanceOf(BootstrapError)
    expect(await world.prisma.admin.findUnique({ where: { email: 'intruder@shop.example' } })).toBeNull()
    expect(await counts()).toEqual(snapshot)
  })

  it('a role or permission edited by an operator is not overwritten by a re-run', async () => {
    await world.prisma.role.update({ where: { name: 'MANAGER' }, data: { description: 'Store manager (edited)' } })
    await bootstrapProduction(world.prisma, readBootstrapCredentials(OWNER))
    expect((await world.prisma.role.findUniqueOrThrow({ where: { name: 'MANAGER' } })).description).toBe('Store manager (edited)')
  })
})
