import * as bcrypt from 'bcryptjs';
import { EventEmitter } from 'events';
import {
  AdminLifecycleError,
  createAdmin,
  disableAdmin,
  parseCreateAdminArgs,
  promptLine,
  runCreateAdmin,
  runDisableAdmin,
} from '../../prisma/bootstrap/admin-lifecycle';

/**
 * prisma/create-admin.ts + prisma/disable-admin.ts (implemented in
 * prisma/bootstrap/admin-lifecycle.ts), against an in-memory Prisma double that
 * honours what the code relies on: unique email, the nested AdminRole create, and a
 * transaction that ROLLS BACK on any error.
 */

jest.setTimeout(30_000);

const PASSWORD = 'Plum-Harbour-Lantern-42';
const SUPER_EMAIL = 'superadmin@baksomassular.com';

interface AdminRow { id: string; email: string; name: string; passwordHash: string; isActive: boolean; createdAt: Date; updatedAt: Date }
interface State { roles: Array<{ id: string; name: string }>; admins: AdminRow[]; adminRoles: Array<{ adminId: string; roleId: string }>; audit: Array<Record<string, unknown>> }

function fakeDb(opts: { roles?: string[]; failAudit?: boolean; failCreateWithHash?: boolean } = {}) {
  const roleNames = opts.roles ?? ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF', 'CUSTOMER', 'Ops Lead'];
  const t0 = new Date('2026-09-13T09:00:00Z');
  let state: State = {
    roles: roleNames.map((name) => ({ id: `role-${name}`, name })),
    admins: [{ id: 'adm-super', email: SUPER_EMAIL, name: 'Super Admin', passwordHash: '$2b$12$existing-super-admin-hash', isActive: true, createdAt: t0, updatedAt: t0 }],
    adminRoles: [{ adminId: 'adm-super', roleId: 'role-SUPER_ADMIN' }],
    audit: [],
  };
  let seq = 0;
  const roleName = (id: string) => state.roles.find((r) => r.id === id)?.name;
  const clone = (s: State): State => ({ roles: [...s.roles], admins: s.admins.map((a) => ({ ...a })), adminRoles: [...s.adminRoles], audit: [...s.audit] });

  const shape = (a: AdminRow) => ({ ...a, roles: state.adminRoles.filter((ar) => ar.adminId === a.id).map((ar) => ({ role: { name: roleName(ar.roleId) } })) });

  const client = {
    $executeRaw: jest.fn(async () => 1),
    role: { findUnique: jest.fn(async ({ where }: { where: { name: string } }) => state.roles.find((r) => r.name === where.name) ?? null) },
    admin: {
      findUnique: jest.fn(async ({ where }: { where: { email: string } }) => {
        const a = state.admins.find((x) => x.email === where.email);
        return a ? shape(a) : null;
      }),
      create: jest.fn(async ({ data }: { data: { email: string; name: string; passwordHash: string; isActive: boolean; roles: { create: { roleId: string } } } }) => {
        if (opts.failCreateWithHash) throw new Error(`Invalid \`prisma.admin.create()\` invocation: { passwordHash: "${data.passwordHash}" }`);
        if (state.admins.some((a) => a.email === data.email)) throw Object.assign(new Error('Unique constraint failed on the fields: (`email`)'), { code: 'P2002' });
        const now = new Date();
        const row: AdminRow = { id: `adm-${++seq}`, email: data.email, name: data.name, passwordHash: data.passwordHash, isActive: data.isActive, createdAt: now, updatedAt: now };
        state.admins.push(row);
        state.adminRoles.push({ adminId: row.id, roleId: data.roles.create.roleId });
        return { id: row.id, email: row.email, name: row.name, isActive: row.isActive };
      }),
      updateMany: jest.fn(async ({ where, data }: { where: { id: string; isActive: boolean }; data: { isActive: boolean } }) => {
        const a = state.admins.find((x) => x.id === where.id && x.isActive === where.isActive);
        if (!a) return { count: 0 };
        a.isActive = data.isActive;
        a.updatedAt = new Date(); // what Prisma's @updatedAt does
        return { count: 1 };
      }),
    },
    adminRole: {
      count: jest.fn(async ({ where }: { where: { role: { name: string }; admin: { isActive: boolean; id: { not: string } } } }) =>
        state.adminRoles.filter((ar) => {
          const admin = state.admins.find((a) => a.id === ar.adminId)!;
          return roleName(ar.roleId) === where.role.name && admin.isActive === where.admin.isActive && admin.id !== where.admin.id.not;
        }).length),
    },
    auditTrail: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (opts.failAudit) throw new Error('audit write failed');
        state.audit.push(data);
        return data;
      }),
    },
    $disconnect: jest.fn(async () => undefined),
  };
  const prisma = {
    ...client,
    $transaction: jest.fn(async (fn: (tx: typeof client) => Promise<unknown>) => {
      const snapshot = clone(state);
      try {
        return await fn(client);
      } catch (err) {
        state = snapshot; // ROLLBACK
        throw err;
      }
    }),
  };
  return { prisma, get state() { return state; } };
}

/** A fake interactive terminal: answers each prompt with the next scripted line and records any echo. */
function fakeTty(answers: string[], opts: { isTTY?: boolean } = {}) {
  const input = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const written: string[] = [];
  input.isTTY = opts.isTTY ?? true;
  input.setRawMode = jest.fn((on: boolean) => {
    if (on) {
      const next = answers.shift();
      if (next !== undefined) setImmediate(() => input.emit('data', `${next}\r`));
    }
  });
  input.setEncoding = jest.fn();
  input.resume = jest.fn();
  input.pause = jest.fn();
  const output = { write: (text: string) => void written.push(String(text)) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { io: { input: input as any, output }, text: () => written.join('') };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const connectTo = (prisma: any) => () => prisma;

describe('create-admin: argument handling', () => {
  it.each([
    ['--password', ['--email', 'a@b.co', '--name', 'A', '--role', 'STAFF', '--password', PASSWORD]],
    ['--password=', ['--email', 'a@b.co', '--name', 'A', '--role', 'STAFF', `--password=${PASSWORD}`]],
    ['--pass', ['--pass', PASSWORD, '--email', 'a@b.co']],
    ['--pwd', ['--pwd', PASSWORD]],
    ['--password-hash', ['--password-hash', '$2b$12$x']],
  ])('NEVER accepts a password through argv (%s)', (_label, argv) => {
    expect(() => parseCreateAdminArgs(argv)).toThrow(/never accepted on the command line/);
  });

  it('normalises the email to lower case and trims the name', () => {
    expect(parseCreateAdminArgs(['--email', '  Person@Example.COM ', '--name', '  Full Name ', '--role', 'staff'])).toEqual({ email: 'person@example.com', name: 'Full Name', role: 'STAFF' });
    expect(parseCreateAdminArgs(['--email=Person@Example.com', '--name=N', '--role=MANAGER']).email).toBe('person@example.com');
  });

  it.each([
    [[], /--email is required/],
    [['--email', '', '--name', 'A', '--role', 'STAFF'], /--email is required/],
    [['--email', 'not-an-email', '--name', 'A', '--role', 'STAFF'], /not a valid email/],
    [['--email', 'admin@test.com', '--name', 'A', '--role', 'STAFF'], /development admin address/],
    [['--email', 'a@b.co', '--role', 'STAFF'], /--name is required/],
    [['--email', 'a@b.co', '--name', '   ', '--role', 'STAFF'], /--name is required/],
    [['--email', 'a@b.co', '--name', 'A'], /--role is required/],
    [['--email', 'a@b.co', '--name', 'A', '--role', 'STAFF', '--role', 'ADMIN'], /more than once/],
    [['--email', 'a@b.co', '--name', 'A', '--role', 'STAFF', '--extra', 'x'], /unknown option/],
    [['--email', 'a@b.co', 'stray'], /unexpected argument/],
  ])('rejects %p', (argv, message) => {
    expect(() => parseCreateAdminArgs(argv as string[])).toThrow(message as RegExp);
  });

  it.each([
    ['SUPER_ADMIN', /SUPER_ADMIN cannot be granted/],
    ['super_admin', /SUPER_ADMIN cannot be granted/],
    ['CUSTOMER', /CUSTOMER is a storefront role/],
    ['Ops Lead', /exactly one of ADMIN, MANAGER, STAFF/],
    ['Super Admin', /exactly one of ADMIN, MANAGER, STAFF/],
    ['ADMIN,STAFF', /exactly one of ADMIN, MANAGER, STAFF/],
    ['ROOT', /exactly one of ADMIN, MANAGER, STAFF/],
  ])('rejects role %s', (role, message) => {
    expect(() => parseCreateAdminArgs(['--email', 'a@b.co', '--name', 'A', '--role', role])).toThrow(message);
  });
});

describe('create-admin: createAdmin()', () => {
  it.each(['ADMIN', 'MANAGER', 'STAFF'] as const)('creates an active %s admin with exactly that one role, atomically', async (role) => {
    const db = fakeDb();
    const created = await createAdmin(db.prisma as never, { email: `${role.toLowerCase()}@shop.example`, name: `${role} Person`, role, password: PASSWORD });

    const admin = db.state.admins.find((a) => a.id === created.adminId)!;
    expect(admin).toMatchObject({ email: `${role.toLowerCase()}@shop.example`, name: `${role} Person`, isActive: true });
    expect(db.state.adminRoles.filter((ar) => ar.adminId === admin.id)).toEqual([{ adminId: admin.id, roleId: `role-${role}` }]);
    expect(db.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(db.prisma.$executeRaw).toHaveBeenCalledTimes(1); // the bootstrap's advisory lock
  });

  it('stores a bcrypt cost-12 hash of the password, never the password', async () => {
    const db = fakeDb();
    const { adminId } = await createAdmin(db.prisma as never, { email: 'staff@shop.example', name: 'S', role: 'STAFF', password: PASSWORD });
    const { passwordHash } = db.state.admins.find((a) => a.id === adminId)!;
    expect(passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(passwordHash).not.toContain(PASSWORD);
    await expect(bcrypt.compare(PASSWORD, passwordHash)).resolves.toBe(true);
  });

  it('writes an AuditTrail CREATE row in the same transaction, without password or hash', async () => {
    const db = fakeDb();
    const { adminId } = await createAdmin(db.prisma as never, { email: 'mgr@shop.example', name: 'M', role: 'MANAGER', password: PASSWORD });
    expect(db.state.audit).toHaveLength(1);
    expect(db.state.audit[0]).toMatchObject({
      module: 'auth', entity: 'Admin', entityId: adminId, entityName: 'mgr@shop.example', action: 'CREATE', success: true,
      after: { email: 'mgr@shop.example', isActive: true, name: 'M', roles: ['MANAGER'] },
    });
    const hash = db.state.admins.find((a) => a.id === adminId)!.passwordHash;
    expect(JSON.stringify(db.state.audit)).not.toContain(PASSWORD);
    expect(JSON.stringify(db.state.audit)).not.toContain(hash);
    expect(JSON.stringify(db.state.audit)).not.toMatch(/password/i);
  });

  it('is atomic: when the audit write fails, no Admin or AdminRole row remains', async () => {
    const db = fakeDb({ failAudit: true });
    await expect(createAdmin(db.prisma as never, { email: 'x@shop.example', name: 'X', role: 'STAFF', password: PASSWORD })).rejects.toThrow('audit write failed');
    expect(db.state.admins.map((a) => a.email)).toEqual([SUPER_EMAIL]);
    expect(db.state.adminRoles).toHaveLength(1);
  });

  it('rejects a duplicate email - case-insensitively - and never modifies the existing admin', async () => {
    const db = fakeDb();
    const before = JSON.stringify(db.state);
    await expect(createAdmin(db.prisma as never, { email: 'SuperAdmin@BaksoMasSular.com', name: 'Impostor', role: 'ADMIN', password: PASSWORD })).rejects.toThrow(/already exists; it was NOT modified/);
    expect(JSON.stringify(db.state)).toBe(before);
  });

  it('fails safely when the role does not exist in the database', async () => {
    const db = fakeDb({ roles: ['SUPER_ADMIN', 'ADMIN'] });
    await expect(createAdmin(db.prisma as never, { email: 'x@shop.example', name: 'X', role: 'STAFF', password: PASSWORD })).rejects.toThrow(/role STAFF does not exist.*sync-rbac/);
    expect(db.state.admins).toHaveLength(1);
  });

  it.each([
    ['short (11 chars)', 'Short-pw-11', /at least 12 characters/],
    ['a well-known value', '123456789012', /well-known or trivially guessable/],
    ['the email itself', 'weak@shop.example', /well-known or trivially guessable/],
  ])('rejects a %s password before any database work', async (_label, password, message) => {
    const db = fakeDb();
    await expect(createAdmin(db.prisma as never, { email: 'weak@shop.example', name: 'W', role: 'STAFF', password })).rejects.toThrow(message);
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('never re-validates away the exclusions: SUPER_ADMIN/CUSTOMER cannot be forced through the function either', async () => {
    const db = fakeDb();
    for (const role of ['SUPER_ADMIN', 'CUSTOMER', 'Ops Lead']) {
      await expect(createAdmin(db.prisma as never, { email: 'x@shop.example', name: 'X', role: role as never, password: PASSWORD })).rejects.toBeInstanceOf(AdminLifecycleError);
    }
    expect(db.state.admins).toHaveLength(1);
  });
});

describe('create-admin: interactive CLI', () => {
  let consoleSpies: jest.SpyInstance[];
  beforeEach(() => {
    consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => undefined));
  });
  afterEach(() => consoleSpies.forEach((s) => s.mockRestore()));
  const consoleText = () => consoleSpies.flatMap((s) => s.mock.calls.flat()).map(String).join('\n');

  const ARGV = ['--email', 'New.Staff@Shop.Example', '--name', 'New Staff', '--role', 'STAFF'];

  it('prompts twice with hidden input and creates the admin; neither password nor hash is ever printed', async () => {
    const db = fakeDb();
    const tty = fakeTty([PASSWORD, PASSWORD]);
    const code = await runCreateAdmin(ARGV, tty.io, connectTo(db.prisma));

    expect(code).toBe(0);
    const admin = db.state.admins.find((a) => a.email === 'new.staff@shop.example')!;
    expect(admin).toBeDefined();
    const out = tty.text() + consoleText();
    expect(out).toContain('Password (hidden): ');
    expect(out).toContain('Repeat password (hidden): ');
    expect(out).toContain('CREATED STAFF admin new.staff@shop.example');
    expect(out).not.toContain(PASSWORD);
    expect(out).not.toContain(admin.passwordHash);
    expect(out).not.toMatch(/\$2[aby]\$/);
    expect(db.prisma.$disconnect).toHaveBeenCalled();
  });

  it('rejects mismatching passwords and creates nothing', async () => {
    const db = fakeDb();
    const tty = fakeTty([PASSWORD, `${PASSWORD}-typo`]);
    expect(await runCreateAdmin(ARGV, tty.io, connectTo(db.prisma))).toBe(1);
    expect(tty.text()).toContain('the two passwords do not match');
    expect(db.state.admins).toHaveLength(1);
    expect(tty.text()).not.toContain(PASSWORD);
  });

  it.each([['short', 'too-short'], ['weak', 'changeme']])('rejects a %s password typed at the prompt', async (_label, password) => {
    const db = fakeDb();
    const tty = fakeTty([password, password]);
    expect(await runCreateAdmin(ARGV, tty.io, connectTo(db.prisma))).toBe(1);
    expect(db.state.admins).toHaveLength(1);
    expect(tty.text()).not.toContain(password);
  });

  it('refuses without an interactive terminal (piped input) before touching the database', async () => {
    const db = fakeDb();
    const connect = jest.fn(connectTo(db.prisma));
    const tty = fakeTty([PASSWORD, PASSWORD], { isTTY: false });
    expect(await runCreateAdmin(ARGV, tty.io, connect)).toBe(1);
    expect(tty.text()).toMatch(/interactive terminal is required/);
    expect(connect).not.toHaveBeenCalled();
  });

  it('refuses a duplicate email BEFORE asking for a password', async () => {
    const db = fakeDb();
    const tty = fakeTty([PASSWORD, PASSWORD]);
    expect(await runCreateAdmin(['--email', SUPER_EMAIL, '--name', 'X', '--role', 'ADMIN'], tty.io, connectTo(db.prisma))).toBe(1);
    expect(tty.text()).toMatch(/already exists; it was NOT modified/);
    expect(tty.text()).not.toContain('Password (hidden)');
  });

  it('an unexpected error that embeds the hash is reported by type only - the hash never reaches the output', async () => {
    const db = fakeDb({ failCreateWithHash: true });
    const tty = fakeTty([PASSWORD, PASSWORD]);
    expect(await runCreateAdmin(ARGV, tty.io, connectTo(db.prisma))).toBe(1);
    const out = tty.text() + consoleText();
    expect(out).toMatch(/FAILED: Error; nothing was changed/);
    expect(out).not.toMatch(/\$2[aby]\$/);
    expect(out).not.toContain(PASSWORD);
  });

  it('a password in argv is refused before any prompt or connection', async () => {
    const connect = jest.fn();
    const tty = fakeTty([]);
    expect(await runCreateAdmin([...ARGV, '--password', PASSWORD], tty.io, connect)).toBe(1);
    expect(connect).not.toHaveBeenCalled();
    expect(tty.text()).not.toContain(PASSWORD);
  });
});

describe('promptLine (hidden terminal input)', () => {
  it('echoes nothing while typing, supports backspace, ends raw mode', async () => {
    const input = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const written: string[] = [];
    Object.assign(input, { isTTY: true, setRawMode: jest.fn(), setEncoding: jest.fn(), resume: jest.fn(), pause: jest.fn() });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pending = promptLine({ input: input as any, output: { write: (t: string) => void written.push(t) } }, 'Password (hidden): ', true);
    input.emit('data', 'secreX');
    input.emit('data', '\u007f'); // backspace removes the X
    input.emit('data', 't-value-1\r');
    await expect(pending).resolves.toBe('secret-value-1');
    expect(written.join('')).toBe('Password (hidden): \n');
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it('Ctrl-C cancels', async () => {
    const input = new EventEmitter() as EventEmitter & Record<string, unknown>;
    Object.assign(input, { isTTY: true, setRawMode: jest.fn(), setEncoding: jest.fn(), resume: jest.fn(), pause: jest.fn() });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pending = promptLine({ input: input as any, output: { write: () => undefined } }, 'P: ', true);
    input.emit('data', 'abc\u0003'); // Ctrl-C mid-entry
    await expect(pending).rejects.toThrow('cancelled');
  });
});

describe('disable-admin', () => {
  async function withStaff(db: ReturnType<typeof fakeDb>) {
    await createAdmin(db.prisma as never, { email: 'staff@shop.example', name: 'Staff', role: 'STAFF', password: PASSWORD });
    db.state.audit.length = 0;
    (db.prisma.$transaction as jest.Mock).mockClear();
    return db.state.admins.find((a) => a.email === 'staff@shop.example')!;
  }

  it('disables an active admin: isActive=false, never deleted, roles unchanged, audited', async () => {
    const db = fakeDb();
    const staff = await withStaff(db);
    const result = await disableAdmin(db.prisma as never, '  STAFF@Shop.Example ');

    expect(result).toEqual({ adminId: staff.id, email: 'staff@shop.example', roles: ['STAFF'] });
    const after = db.state.admins.find((a) => a.id === staff.id)!;
    expect(after.isActive).toBe(false);
    expect(after.passwordHash).toBe(staff.passwordHash);
    expect(db.state.adminRoles.filter((ar) => ar.adminId === staff.id)).toEqual([{ adminId: staff.id, roleId: 'role-STAFF' }]);
    expect(db.state.audit).toEqual([
      expect.objectContaining({
        module: 'auth', entity: 'Admin', entityId: staff.id, action: 'DEACTIVATE', success: true,
        before: { email: 'staff@shop.example', name: 'Staff', roles: ['STAFF'], isActive: true },
        after: { email: 'staff@shop.example', name: 'Staff', roles: ['STAFF'], isActive: false },
        diff: [{ field: 'isActive', before: true, after: false }],
      }),
    ]);
    expect(JSON.stringify(db.state.audit)).not.toMatch(/password|\$2[aby]\$/i);
  });

  it('refuses an already-inactive admin and changes nothing', async () => {
    const db = fakeDb();
    await withStaff(db);
    await disableAdmin(db.prisma as never, 'staff@shop.example');
    const snapshot = JSON.stringify(db.state);
    await expect(disableAdmin(db.prisma as never, 'staff@shop.example')).rejects.toThrow(/already inactive; nothing changed/);
    expect(JSON.stringify(db.state)).toBe(snapshot);
  });

  it('refuses a nonexistent admin', async () => {
    const db = fakeDb();
    await expect(disableAdmin(db.prisma as never, 'ghost@shop.example')).rejects.toThrow(/no admin has this email/);
    expect(db.state.audit).toHaveLength(0);
  });

  it('NEVER disables the only active SUPER_ADMIN', async () => {
    const db = fakeDb();
    await expect(disableAdmin(db.prisma as never, SUPER_EMAIL)).rejects.toThrow(/only active SUPER_ADMIN/);
    expect(db.state.admins[0].isActive).toBe(true);
    expect(db.state.audit).toHaveLength(0);
  });

  it('an inactive second SUPER_ADMIN does not count: the last ACTIVE one is still protected', async () => {
    const db = fakeDb();
    db.state.admins.push({ ...db.state.admins[0], id: 'adm-super-2', email: 'old-super@shop.example', isActive: false });
    db.state.adminRoles.push({ adminId: 'adm-super-2', roleId: 'role-SUPER_ADMIN' });
    await expect(disableAdmin(db.prisma as never, SUPER_EMAIL)).rejects.toThrow(/only active SUPER_ADMIN/);
  });

  it('a SUPER_ADMIN may be disabled only while another active SUPER_ADMIN remains', async () => {
    const db = fakeDb();
    db.state.admins.push({ ...db.state.admins[0], id: 'adm-super-2', email: 'second-super@shop.example', isActive: true });
    db.state.adminRoles.push({ adminId: 'adm-super-2', roleId: 'role-SUPER_ADMIN' });
    await disableAdmin(db.prisma as never, 'second-super@shop.example');
    await expect(disableAdmin(db.prisma as never, SUPER_EMAIL)).rejects.toThrow(/only active SUPER_ADMIN/);
  });

  it('CLI: shows the target, requires the email to be retyped, then disables', async () => {
    const db = fakeDb();
    await withStaff(db);
    const tty = fakeTty(['Staff@Shop.Example']);
    expect(await runDisableAdmin(['--email', 'staff@shop.example'], tty.io, connectTo(db.prisma))).toBe(0);
    expect(tty.text()).toMatch(/target: staff@shop.example \("Staff"\), roles: STAFF, active: true/);
    expect(tty.text()).toMatch(/DISABLED staff@shop.example .*roles unchanged/);
    expect(db.state.admins.find((a) => a.email === 'staff@shop.example')!.isActive).toBe(false);
  });

  it('CLI: a confirmation mismatch changes nothing', async () => {
    const db = fakeDb();
    await withStaff(db);
    const tty = fakeTty(['someone-else@shop.example']);
    expect(await runDisableAdmin(['--email', 'staff@shop.example'], tty.io, connectTo(db.prisma))).toBe(1);
    expect(tty.text()).toMatch(/confirmation did not match; nothing changed/);
    expect(db.state.admins.find((a) => a.email === 'staff@shop.example')!.isActive).toBe(true);
  });

  it('CLI: --yes skips the prompt; the SUPER_ADMIN guard still applies', async () => {
    const db = fakeDb();
    const tty = fakeTty([], { isTTY: false });
    expect(await runDisableAdmin(['--email', SUPER_EMAIL, '--yes'], tty.io, connectTo(db.prisma))).toBe(1);
    expect(tty.text()).toMatch(/REFUSED: refusing to disable the only active SUPER_ADMIN/);
    expect(db.state.admins[0].isActive).toBe(true);
  });

  it('CLI: output never contains the password hash', async () => {
    const db = fakeDb();
    const staff = await withStaff(db);
    const tty = fakeTty([], { isTTY: false });
    await runDisableAdmin(['--email', 'staff@shop.example', '--yes'], tty.io, connectTo(db.prisma));
    expect(tty.text()).not.toContain(staff.passwordHash);
    expect(tty.text()).not.toMatch(/\$2[aby]\$/);
  });
});
