import * as bcrypt from 'bcryptjs';
import type { PrismaClient } from '@prisma/client';
import { SUPER_ADMIN_ROLE } from './permission-catalogue';
import { assertAdminEmail, assertAdminPassword, BOOTSTRAP_LOCK_KEY, BootstrapError } from './production-bootstrap';

/**
 * Operator tooling for admin-panel accounts: prisma/create-admin.ts and
 * prisma/disable-admin.ts (thin CLI wrappers around this module).
 *
 * Why a CLI and not an HTTP endpoint: the project has no admin-management API or UI
 * yet, and prisma/bootstrap-production.ts creates only the FIRST Super Admin. These
 * tools follow the bootstrap's conventions exactly - its email/password rules
 * (shared functions), bcrypt cost 12, the same advisory lock, one transaction - and
 * add what a CLI path bypasses: an AuditTrail row, because the HTTP audit
 * interceptor never sees these writes.
 *
 * Secrets: the password is only ever read from an interactive terminal with hidden
 * input, typed twice. It is never accepted in argv or the environment, never
 * printed, and neither it nor its hash is written to any log or audit row.
 *
 * Deliberately imports nothing from src/: the migrator image ships prisma/ only.
 */

/** Roles these tools may assign. SUPER_ADMIN (bootstrap only), CUSTOMER and custom roles are refused. */
export const ASSIGNABLE_ADMIN_ROLES = ['ADMIN', 'MANAGER', 'STAFF'] as const;
export type AssignableAdminRole = (typeof ASSIGNABLE_ADMIN_ROLES)[number];

/** Same cost as prisma/bootstrap/production-bootstrap.ts. */
export const ADMIN_BCRYPT_COST = 12;

/** A refusal the operator must act on. Its message never contains a secret. */
export class AdminLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminLifecycleError';
  }
}

type LifecycleClient = Pick<PrismaClient, 'admin' | 'adminRole' | 'role' | 'auditTrail' | '$transaction'>;

/** Recorded as the actor of CLI-made changes (there is no admin session behind them). */
const CLI_ACTOR = { create: 'operator CLI (prisma/create-admin.ts)', disable: 'operator CLI (prisma/disable-admin.ts)' } as const;

// ------------------------------------------------------------------ args ----

const PASSWORD_LIKE_FLAG = /pass|pwd|secret|hash|token/i;

/** Parses `--key value` / `--key=value` pairs. Refuses unknown flags, repeats and positionals. */
function parseFlags(argv: readonly string[], allowed: readonly string[], booleans: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new AdminLifecycleError(`unexpected argument "${arg.slice(0, 40)}"`);
    const eq = arg.indexOf('=');
    const key = arg.slice(2, eq === -1 ? undefined : eq);
    // Checked first, so a password passed on the command line is never even parsed.
    if (PASSWORD_LIKE_FLAG.test(key)) {
      throw new AdminLifecycleError('passwords are never accepted on the command line; you will be prompted for it');
    }
    if (!allowed.includes(key) && !booleans.includes(key)) throw new AdminLifecycleError(`unknown option --${key}`);
    if (key in out) throw new AdminLifecycleError(`--${key} given more than once`);
    if (booleans.includes(key)) {
      if (eq !== -1) throw new AdminLifecycleError(`--${key} takes no value`);
      out[key] = 'true';
      continue;
    }
    const value = eq !== -1 ? arg.slice(eq + 1) : argv[i + 1];
    if (eq === -1) i += 1;
    if (value === undefined || value.startsWith('--')) throw new AdminLifecycleError(`--${key} needs a value`);
    out[key] = value;
  }
  return out;
}

const normalizeEmail = (raw: string | undefined) => (raw ?? '').trim().toLowerCase();

function validEmail(raw: string | undefined): string {
  const email = normalizeEmail(raw);
  if (!email) throw new AdminLifecycleError('--email is required');
  try {
    assertAdminEmail(email, '--email');
  } catch (err) {
    throw new AdminLifecycleError(err instanceof BootstrapError ? err.message : '--email is not valid');
  }
  return email;
}

export function validRole(raw: string | undefined): AssignableAdminRole {
  const role = (raw ?? '').trim().toUpperCase();
  if (!role) throw new AdminLifecycleError(`--role is required (one of ${ASSIGNABLE_ADMIN_ROLES.join(', ')})`);
  if (role === SUPER_ADMIN_ROLE) {
    throw new AdminLifecycleError('SUPER_ADMIN cannot be granted with this tool (the first Super Admin comes from bootstrap-production)');
  }
  if (role === 'CUSTOMER') throw new AdminLifecycleError('CUSTOMER is a storefront role, not an admin-panel role');
  if (!(ASSIGNABLE_ADMIN_ROLES as readonly string[]).includes(role)) {
    throw new AdminLifecycleError(`--role must be exactly one of ${ASSIGNABLE_ADMIN_ROLES.join(', ')}`);
  }
  return role as AssignableAdminRole;
}

export interface CreateAdminArgs {
  email: string;
  name: string;
  role: AssignableAdminRole;
}

export function parseCreateAdminArgs(argv: readonly string[]): CreateAdminArgs {
  const flags = parseFlags(argv, ['email', 'name', 'role']);
  const email = validEmail(flags.email);
  const name = (flags.name ?? '').trim();
  if (!name) throw new AdminLifecycleError('--name is required (the person\'s display name)');
  return { email, name, role: validRole(flags.role) };
}

export function parseDisableAdminArgs(argv: readonly string[]): { email: string; yes: boolean } {
  const flags = parseFlags(argv, ['email'], ['yes']);
  return { email: validEmail(flags.email), yes: flags.yes === 'true' };
}

/** The bootstrap's password rules (length >= 12, refused list, not the email) plus the confirmation. */
export function validateNewPassword(password: string, confirmation: string, email: string): void {
  try {
    assertAdminPassword(password, email, 'the password');
  } catch (err) {
    throw new AdminLifecycleError(err instanceof BootstrapError ? err.message : 'the password was refused');
  }
  if (password !== confirmation) throw new AdminLifecycleError('the two passwords do not match');
}

// ------------------------------------------------------------ operations ----

export interface CreatedAdmin {
  adminId: string;
  email: string;
  name: string;
  role: AssignableAdminRole;
}

/**
 * Creates one active admin holding exactly one of ADMIN/MANAGER/STAFF, atomically
 * with its AdminRole row and an AuditTrail row. Never modifies an existing admin.
 */
export async function createAdmin(prisma: LifecycleClient, input: CreateAdminArgs & { password: string }): Promise<CreatedAdmin> {
  const email = validEmail(input.email);
  const role = validRole(input.role);
  const name = input.name.trim();
  if (!name) throw new AdminLifecycleError('the display name must not be empty');
  validateNewPassword(input.password, input.password, email);

  // Hash BEFORE taking the lock: bcrypt is slow and must not hold other operators up.
  const passwordHash = await bcrypt.hash(input.password, ADMIN_BCRYPT_COST);

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`;

    const roleRow = await tx.role.findUnique({ where: { name: role }, select: { id: true, name: true } });
    if (!roleRow) throw new AdminLifecycleError(`role ${role} does not exist in this database; run prisma/sync-rbac.ts first`);

    const existing = await tx.admin.findUnique({ where: { email }, select: { id: true } });
    if (existing) throw new AdminLifecycleError('an admin with this email already exists; it was NOT modified');

    const admin = await tx.admin.create({
      data: { email, name, passwordHash, isActive: true, roles: { create: { roleId: roleRow.id } } },
      select: { id: true, email: true, name: true, isActive: true },
    });

    await tx.auditTrail.create({
      data: {
        adminName: CLI_ACTOR.create,
        module: 'auth',
        entity: 'Admin',
        entityId: admin.id,
        entityName: admin.email,
        action: 'CREATE',
        // Same shape AuditTrailService stores for a CREATE: the full after-snapshot. No password, no hash.
        after: { email: admin.email, isActive: admin.isActive, name: admin.name, roles: [role] },
        metadata: { via: 'cli', script: 'prisma/create-admin.ts' },
        success: true,
      },
    });

    return { adminId: admin.id, email: admin.email, name: admin.name, role };
  });
}

export interface DisabledAdmin {
  adminId: string;
  email: string;
  roles: string[];
}

/**
 * Sets isActive=false on one admin - nothing else (no delete, no role change).
 * Refuses an unknown or already-inactive admin, and the last active SUPER_ADMIN.
 * Takes effect on the admin's very next request: AdminJwtStrategy re-checks
 * isActive on every request, so no session survives it.
 */
export async function disableAdmin(prisma: LifecycleClient, rawEmail: string): Promise<DisabledAdmin> {
  const email = validEmail(rawEmail);

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`;

    const admin = await tx.admin.findUnique({
      where: { email },
      select: { id: true, email: true, name: true, isActive: true, roles: { select: { role: { select: { name: true } } } } },
    });
    if (!admin) throw new AdminLifecycleError('no admin has this email; nothing changed');
    if (!admin.isActive) throw new AdminLifecycleError('this admin is already inactive; nothing changed');

    const roles = admin.roles.map((r) => r.role.name).sort();
    if (roles.includes(SUPER_ADMIN_ROLE)) {
      const otherActiveSuperAdmins = await tx.adminRole.count({
        where: { role: { name: SUPER_ADMIN_ROLE }, admin: { isActive: true, id: { not: admin.id } } },
      });
      if (otherActiveSuperAdmins === 0) {
        throw new AdminLifecycleError('refusing to disable the only active SUPER_ADMIN; nothing changed');
      }
    }

    const { count } = await tx.admin.updateMany({ where: { id: admin.id, isActive: true }, data: { isActive: false } });
    if (count !== 1) throw new AdminLifecycleError('the admin changed concurrently; nothing changed');

    const snapshot = { email: admin.email, name: admin.name, roles };
    await tx.auditTrail.create({
      data: {
        adminName: CLI_ACTOR.disable,
        module: 'auth',
        entity: 'Admin',
        entityId: admin.id,
        entityName: admin.email,
        action: 'DEACTIVATE',
        // Same shape AuditTrailService stores for an update: before/after + field diff.
        before: { ...snapshot, isActive: true },
        after: { ...snapshot, isActive: false },
        diff: [{ field: 'isActive', before: true, after: false }],
        metadata: { via: 'cli', script: 'prisma/disable-admin.ts' },
        success: true,
      },
    });

    return { adminId: admin.id, email: admin.email, roles };
  });
}

// ---------------------------------------------------------------- prompts ----

export interface PromptInput {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
  removeListener(event: 'data', listener: (chunk: string) => void): unknown;
}

export interface PromptIO {
  input: PromptInput;
  output: { write(text: string): unknown };
}

function requireTty(input: PromptInput): void {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new AdminLifecycleError('an interactive terminal is required (run without `-T`; input must not be piped)');
  }
}

/**
 * Reads one line from the terminal in raw mode. With `hidden`, NOTHING is echoed
 * (not even asterisks, which would reveal the length). Ctrl-C / Ctrl-D cancel.
 */
export function promptLine(io: PromptIO, question: string, hidden: boolean): Promise<string> {
  const { input, output } = io;
  requireTty(input);
  return new Promise((resolve, reject) => {
    let value = '';
    const done = (err?: Error) => {
      input.removeListener('data', onData);
      input.setRawMode!(false);
      input.pause();
      output.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003' || ch === '\u0004') return done(new AdminLifecycleError('cancelled')); // Ctrl-C / Ctrl-D
        if (ch === '\u007f' || ch === '\b') { // Backspace / Delete
          if (value.length > 0) {
            value = value.slice(0, -1);
            if (!hidden) output.write('\b \b');
          }
          continue;
        }
        if (ch < ' ') continue; // other control characters (arrow-key escapes, tabs)
        value += ch;
        if (!hidden) output.write(ch);
      }
    };
    output.write(question);
    input.setRawMode!(true);
    input.setEncoding('utf8');
    input.on('data', onData);
    input.resume();
  });
}

// -------------------------------------------------------------- runners ----

type Say = (line: string) => void;

/** Only a lifecycle refusal's own message is shown; anything else prints its type, never its text. */
function report(say: Say, script: string, err: unknown): number {
  if (err instanceof AdminLifecycleError) {
    say(`[${script}] REFUSED: ${err.message}`);
  } else {
    // An unexpected (e.g. Prisma validation) error can embed the query's arguments -
    // including the password hash - in its message, so the message is never printed.
    const code = (err as { code?: unknown } | null)?.code;
    say(`[${script}] FAILED: ${err instanceof Error ? err.name : 'unknown error'}${typeof code === 'string' ? ` (${code})` : ''}; nothing was changed`);
  }
  return 1;
}

export async function runCreateAdmin(argv: readonly string[], io: PromptIO, connect: () => LifecycleClient & { $disconnect(): Promise<void> }): Promise<number> {
  const say: Say = (line) => void io.output.write(`${line}\n`);
  let prisma: (LifecycleClient & { $disconnect(): Promise<void> }) | undefined;
  try {
    const args = parseCreateAdminArgs(argv);
    requireTty(io.input); // before any database work

    prisma = connect();
    // Early, read-only checks so the operator is not asked for a password in vain.
    // The transaction re-checks both authoritatively.
    if (!(await prisma.role.findUnique({ where: { name: args.role }, select: { id: true } }))) {
      throw new AdminLifecycleError(`role ${args.role} does not exist in this database; run prisma/sync-rbac.ts first`);
    }
    if (await prisma.admin.findUnique({ where: { email: args.email }, select: { id: true } })) {
      throw new AdminLifecycleError('an admin with this email already exists; it was NOT modified');
    }

    say(`[create-admin] creating ${args.role} admin ${args.email} ("${args.name}")`);
    const password = await promptLine(io, 'Password (hidden): ', true);
    const confirmation = await promptLine(io, 'Repeat password (hidden): ', true);
    validateNewPassword(password, confirmation, args.email);

    const created = await createAdmin(prisma, { ...args, password });
    say(`[create-admin] CREATED ${created.role} admin ${created.email} (id ${created.adminId}); audit trail recorded`);
    return 0;
  } catch (err) {
    return report(say, 'create-admin', err);
  } finally {
    await prisma?.$disconnect();
  }
}

export async function runDisableAdmin(argv: readonly string[], io: PromptIO, connect: () => LifecycleClient & { $disconnect(): Promise<void> }): Promise<number> {
  const say: Say = (line) => void io.output.write(`${line}\n`);
  let prisma: (LifecycleClient & { $disconnect(): Promise<void> }) | undefined;
  try {
    const args = parseDisableAdminArgs(argv);
    if (!args.yes) requireTty(io.input);

    prisma = connect();
    const target = await prisma.admin.findUnique({
      where: { email: args.email },
      select: { email: true, name: true, isActive: true, roles: { select: { role: { select: { name: true } } } } },
    });
    if (!target) throw new AdminLifecycleError('no admin has this email; nothing changed');
    say(`[disable-admin] target: ${target.email} ("${target.name}"), roles: ${target.roles.map((r) => r.role.name).join(', ') || '-'}, active: ${target.isActive}`);

    if (!args.yes) {
      const typed = normalizeEmail(await promptLine(io, 'Type the email again to confirm: ', false));
      if (typed !== args.email) throw new AdminLifecycleError('confirmation did not match; nothing changed');
    }

    const disabled = await disableAdmin(prisma, args.email);
    say(`[disable-admin] DISABLED ${disabled.email} (id ${disabled.adminId}); roles unchanged; audit trail recorded`);
    return 0;
  } catch (err) {
    return report(say, 'disable-admin', err);
  } finally {
    await prisma?.$disconnect();
  }
}
