import * as bcrypt from 'bcryptjs';
import type { PrismaClient } from '@prisma/client';
import { ensureRbac } from './rbac';

/**
 * Production database bootstrap (production-readiness B5).
 *
 * One-shot and idempotent. It creates exactly two things:
 *   1. the role/permission catalogue (create-only, shared with the dev seed), and
 *   2. the FIRST Super Admin, from operator-supplied credentials.
 * It creates no product, category, topping, voucher, bank account, outlet or
 * customer, and it never updates an existing admin - not its password, name,
 * status or roles. Everything else is configured by the operator in the admin UI.
 */
export const MIN_ADMIN_PASSWORD_LENGTH = 12;

/** Passwords that are refused outright, whatever their length. */
const REFUSED_PASSWORDS = new Set(['admin', 'password', 'administrator', 'changeme', 'change_me', '123456789012', 'superadmin']);

export const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The development seed's admin address (prisma/seed.ts). Never a real admin. */
export const DEV_ADMIN_EMAIL = 'admin@test.com';

/** A refusal the operator must act on. Raised BEFORE any database write where possible. */
export class BootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapError';
  }
}

export interface BootstrapCredentials {
  email: string;
  password: string;
  name: string;
}

/** Validate operator input from the environment. Never logs or echoes the password. */
export function readBootstrapCredentials(env: NodeJS.ProcessEnv = process.env): BootstrapCredentials {
  const email = env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase() ?? '';
  const password = env.BOOTSTRAP_ADMIN_PASSWORD ?? '';
  const name = env.BOOTSTRAP_ADMIN_NAME?.trim() || 'Super Admin';

  const missing = [!email && 'BOOTSTRAP_ADMIN_EMAIL', !password && 'BOOTSTRAP_ADMIN_PASSWORD'].filter(Boolean);
  if (missing.length) throw new BootstrapError(`missing required credentials: ${missing.join(', ')}`);
  assertAdminEmail(email, 'BOOTSTRAP_ADMIN_EMAIL');
  assertAdminPassword(password, email, 'BOOTSTRAP_ADMIN_PASSWORD');
  return { email, password, name };
}

/**
 * The admin email rules, shared by the bootstrap and prisma/create-admin.ts.
 * `email` must already be trimmed and lower-cased. `label` names the input in the message.
 */
export function assertAdminEmail(email: string, label: string): void {
  if (!EMAIL_SHAPE.test(email)) throw new BootstrapError(`${label} is not a valid email address`);
  if (email === DEV_ADMIN_EMAIL) throw new BootstrapError(`${label} must not be the development admin address`);
}

/**
 * The admin password rules, shared by the bootstrap and prisma/create-admin.ts, so
 * every admin password passes the same checks. Never echoes the password.
 */
export function assertAdminPassword(password: string, email: string, label: string): void {
  if (password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    throw new BootstrapError(`${label} must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters`);
  }
  if (REFUSED_PASSWORDS.has(password.toLowerCase()) || password.toLowerCase() === email) {
    throw new BootstrapError(`${label} is a well-known or trivially guessable value`);
  }
}

export type BootstrapOutcome =
  | { admin: 'created'; email: string; adminId: string; permissions: number }
  | { admin: 'unchanged'; email: string; adminId: string; permissions: number };

type BootstrapClient = Pick<PrismaClient, 'role' | 'permission' | 'rolePermission' | 'admin' | 'adminRole' | '$transaction'>;

// Serialises concurrent bootstrap runs inside PostgreSQL (released at commit).
// Also taken by prisma/create-admin.ts and prisma/disable-admin.ts, so every admin
// lifecycle change is serialised against every other one.
export const BOOTSTRAP_LOCK_KEY = 7_274_274_014;

export async function bootstrapProduction(prisma: BootstrapClient, credentials: BootstrapCredentials): Promise<BootstrapOutcome> {
  const rbac = await ensureRbac(prisma);

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`;

    // The same address again: leave it exactly as it is (idempotent re-run, and an
    // operator-changed password is never reset).
    const existing = await tx.admin.findUnique({ where: { email: credentials.email }, select: { id: true } });
    if (existing) return { admin: 'unchanged', email: credentials.email, adminId: existing.id, permissions: rbac.permissions };

    // "First" Super Admin only. Further admins are created in the admin UI, where
    // they are audited, not by re-running a bootstrap with a new address.
    const superAdmins = await tx.adminRole.count({ where: { roleId: rbac.superAdminRoleId } });
    if (superAdmins > 0) {
      throw new BootstrapError('a Super Admin already exists; create further admins from the admin panel');
    }

    const admin = await tx.admin.create({
      data: {
        email: credentials.email,
        name: credentials.name,
        passwordHash: await bcrypt.hash(credentials.password, 12),
        isActive: true,
        roles: { create: { roleId: rbac.superAdminRoleId } },
      },
      select: { id: true },
    });
    return { admin: 'created', email: credentials.email, adminId: admin.id, permissions: rbac.permissions };
  });
}
