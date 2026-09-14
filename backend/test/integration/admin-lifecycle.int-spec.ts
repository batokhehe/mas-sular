/**
 * prisma/create-admin.ts + prisma/disable-admin.ts against a FRESH, migrated
 * PostgreSQL (Testcontainers - never a real environment). Proves the Prisma query
 * shapes (nested AdminRole create, the relation-filtered SUPER_ADMIN count, the
 * advisory lock) behave on the real engine, not only on the unit-test double.
 */
import * as bcrypt from 'bcryptjs'
import { AdminLifecycleError, createAdmin, disableAdmin } from '../../prisma/bootstrap/admin-lifecycle'
import { bootstrapProduction, readBootstrapCredentials } from '../../prisma/bootstrap/production-bootstrap'
import { getWorld, IntegrationWorld } from './world'

const OWNER = { BOOTSTRAP_ADMIN_EMAIL: 'owner@shop.example', BOOTSTRAP_ADMIN_PASSWORD: 'first-operator-passphrase-01' }
const PASSWORD = 'Plum-Harbour-Lantern-42'

describe('admin lifecycle CLI tools (real DB)', () => {
  let world: IntegrationWorld

  beforeAll(async () => {
    world = await getWorld()
    await bootstrapProduction(world.prisma, readBootstrapCredentials(OWNER)) // roles + the one SUPER_ADMIN
  })

  it('creates ADMIN, MANAGER and STAFF accounts with exactly one role each, bcrypt-12, audited', async () => {
    for (const role of ['ADMIN', 'MANAGER', 'STAFF'] as const) {
      const created = await createAdmin(world.prisma, { email: `${role}.Person@Shop.Example`, name: `${role} Person`, role, password: PASSWORD })
      const admin = await world.prisma.admin.findUniqueOrThrow({ where: { id: created.adminId }, include: { roles: { include: { role: true } } } })
      expect(admin.email).toBe(`${role.toLowerCase()}.person@shop.example`)
      expect(admin.isActive).toBe(true)
      expect(admin.roles.map((r) => r.role.name)).toEqual([role])
      expect(admin.passwordHash).toMatch(/^\$2[aby]\$12\$/)
      expect(await bcrypt.compare(PASSWORD, admin.passwordHash)).toBe(true)

      const audit = await world.prisma.auditTrail.findMany({ where: { entity: 'Admin', entityId: admin.id } })
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({ module: 'auth', action: 'CREATE', success: true, entityName: admin.email })
      expect(JSON.stringify(audit)).not.toContain(admin.passwordHash)
    }
  })

  it('refuses a duplicate email and leaves the existing SUPER_ADMIN exactly as it was', async () => {
    const before = await world.prisma.admin.findUniqueOrThrow({ where: { email: 'owner@shop.example' }, include: { roles: true } })
    await expect(createAdmin(world.prisma, { email: 'OWNER@shop.example', name: 'Impostor', role: 'ADMIN', password: PASSWORD })).rejects.toBeInstanceOf(AdminLifecycleError)
    const after = await world.prisma.admin.findUniqueOrThrow({ where: { email: 'owner@shop.example' }, include: { roles: true } })
    expect(after).toEqual(before)
  })

  it('disables a STAFF account without deleting it or touching its role; refuses a second time', async () => {
    const target = await world.prisma.admin.findUniqueOrThrow({ where: { email: 'staff.person@shop.example' } })
    await disableAdmin(world.prisma, 'STAFF.person@shop.example')
    const after = await world.prisma.admin.findUniqueOrThrow({ where: { id: target.id }, include: { roles: { include: { role: true } } } })
    expect(after.isActive).toBe(false)
    expect(after.roles.map((r) => r.role.name)).toEqual(['STAFF'])
    expect(after.passwordHash).toBe(target.passwordHash)
    expect(after.updatedAt.getTime()).toBeGreaterThan(target.updatedAt.getTime())
    expect(await world.prisma.auditTrail.count({ where: { entityId: target.id, action: 'DEACTIVATE' } })).toBe(1)

    await expect(disableAdmin(world.prisma, 'staff.person@shop.example')).rejects.toThrow(/already inactive/)
  })

  it('never disables the only active SUPER_ADMIN (relation-filtered count on the real engine)', async () => {
    await expect(disableAdmin(world.prisma, 'owner@shop.example')).rejects.toThrow(/only active SUPER_ADMIN/)
    expect((await world.prisma.admin.findUniqueOrThrow({ where: { email: 'owner@shop.example' } })).isActive).toBe(true)
  })
})
