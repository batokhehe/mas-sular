import 'reflect-metadata';
import { ExecutionContext, ForbiddenException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IntegrationDirection, IntegrationOutcome, IntegrationProvider } from '@prisma/client';
import { AdminIntegrationLogController } from '../../src/modules/admin/presentation/admin-integration-log.controller';
import { ListIntegrationLogsQueryDto } from '../../src/modules/admin/application/dto/integration-log-query.dto';
import { IntegrationLogQueryService } from '../../src/infrastructure/integration-log/integration-log-query.service';
import { PERMISSIONS_KEY } from '../../src/common/decorators/permissions.decorator';
import { PermissionGuard } from '../../src/common/guards/permission.guard';
import { AdminGuard } from '../../src/common/guards/admin.guard';
import { ALL_PERMISSION_NAMES, ROLE_PERMISSION_MATRIX } from '../../prisma/bootstrap/permission-catalogue';

/** Admin surface: authorization, filtering, pagination, ordering, detail. */

describe('RBAC', () => {
  const perms = (m: keyof AdminIntegrationLogController) => Reflect.getMetadata(PERMISSIONS_KEY, AdminIntegrationLogController.prototype[m]);

  it('every route requires IntegrationLog.read behind AdminGuard + PermissionGuard', () => {
    expect(Reflect.getMetadata('__guards__', AdminIntegrationLogController)).toEqual([AdminGuard, PermissionGuard]);
    for (const m of ['list', 'get', 'byOperation'] as const) expect(perms(m)).toEqual(['IntegrationLog.read']);
  });

  it('IntegrationLog.read is in the canonical catalogue and granted to NO role (SUPER_ADMIN only)', () => {
    expect(ALL_PERMISSION_NAMES).toContain('IntegrationLog.read');
    for (const role of ['ADMIN', 'MANAGER', 'STAFF', 'CUSTOMER'] as const) {
      expect(ROLE_PERMISSION_MATRIX[role]).not.toContain('IntegrationLog.read');
    }
  });

  it('the guard refuses every non-super-admin role and an anonymous caller', () => {
    const guard = new PermissionGuard(new Reflector());
    const ctx = (user: unknown) =>
      ({
        getHandler: () => AdminIntegrationLogController.prototype.list,
        getClass: () => AdminIntegrationLogController,
        switchToHttp: () => ({ getRequest: () => ({ user }) }),
      }) as unknown as ExecutionContext;

    expect(guard.canActivate(ctx({ role: 'SUPER_ADMIN', permissions: [] }))).toBe(true);
    for (const role of ['ADMIN', 'MANAGER', 'STAFF', 'CUSTOMER'] as const) {
      expect(() => guard.canActivate(ctx({ role, permissions: [...ROLE_PERMISSION_MATRIX[role]] }))).toThrow(ForbiddenException);
    }
    expect(() => guard.canActivate(ctx(undefined))).toThrow(ForbiddenException);
    // An explicit grant works too (a custom role given the permission).
    expect(guard.canActivate(ctx({ role: 'OPS', permissions: ['IntegrationLog.read'] }))).toBe(true);
  });
});

describe('query DTO', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } });
  const parse = (q: unknown) => pipe.transform(q, { type: 'query', metatype: ListIntegrationLogsQueryDto });

  it('accepts the documented filters and coerces types', async () => {
    await expect(
      parse({ provider: 'JNE', operation: 'GENERATE_CNOTE', direction: 'OUTBOUND', applicationOutcome: 'PARSE_FAILED', httpStatus: '200', orderId: 'o1', dateFrom: '2026-09-01T00:00:00Z', page: '2', limit: '50', sort: 'asc' }),
    ).resolves.toMatchObject({
      provider: IntegrationProvider.JNE,
      direction: IntegrationDirection.OUTBOUND,
      applicationOutcome: IntegrationOutcome.PARSE_FAILED,
      httpStatus: 200,
      page: 2,
      limit: 50,
      sort: 'asc',
    });
  });

  it.each([
    ['unknown provider', { provider: 'DHL' }],
    ['unknown outcome', { applicationOutcome: 'MAYBE' }],
    ['unknown direction', { direction: 'SIDEWAYS' }],
    ['bad sort', { sort: 'sideways' }],
    ['page 0', { page: '0' }],
    ['unknown field', { secret: 'x' }],
  ])('rejects %s', async (_label, q) => {
    await expect(parse(q)).rejects.toBeDefined();
  });
});

describe('query service', () => {
  const rows = [{ id: 'l1' }];
  function build() {
    const findMany = jest.fn().mockResolvedValue(rows);
    const count = jest.fn().mockResolvedValue(137);
    const findUnique = jest.fn().mockResolvedValue(null);
    const service = new IntegrationLogQueryService({ integrationApiLog: { findMany, count, findUnique } } as never);
    return { service, findMany, count, findUnique };
  }

  it('is newest-first and paginated with the repository envelope', async () => {
    const { service, findMany } = build();
    const result = await service.list({ page: 2, limit: 50 });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { createdAt: 'desc' }, skip: 50, take: 50 }));
    expect(result).toEqual({ items: rows, page: 2, limit: 50, total: 137, totalPages: 3 });
    expect(result).not.toHaveProperty('data');
    expect(result).not.toHaveProperty('meta');
  });

  it('clamps an oversized limit and defaults the page (database protection)', async () => {
    const { service, findMany } = build();
    await service.list({ limit: 5_000 });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 100 }));
  });

  it('sort=asc is honoured', async () => {
    const { service, findMany } = build();
    await service.list({ sort: 'asc' });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { createdAt: 'asc' } }));
  });

  it('filters map to indexed columns; search stays on identifiers and the error message', () => {
    const { service } = build();
    expect(
      service.buildWhere({
        provider: IntegrationProvider.MIDTRANS,
        operation: 'charge',
        direction: IntegrationDirection.OUTBOUND,
        applicationOutcome: IntegrationOutcome.HTTP_ERROR,
        httpStatus: 500,
        orderId: 'o1',
        paymentId: 'p1',
        shipmentId: 's1',
        dateFrom: new Date('2026-09-01'),
        dateTo: new Date('2026-09-30'),
      }),
    ).toMatchObject({
      provider: 'MIDTRANS',
      operation: 'charge',
      direction: 'OUTBOUND',
      applicationOutcome: 'HTTP_ERROR',
      httpStatus: 500,
      orderId: 'o1',
      paymentId: 'p1',
      shipmentId: 's1',
      createdAt: { gte: new Date('2026-09-01'), lte: new Date('2026-09-30') },
    });

    const searched = service.buildWhere({ search: 'BMS-1' });
    expect(searched.OR).toEqual(
      expect.arrayContaining([{ orderId: 'BMS-1' }, { operationId: 'BMS-1' }, { errorMessage: { contains: 'BMS-1' } }]),
    );
    // Payload JSON is deliberately not searched.
    expect(JSON.stringify(searched)).not.toContain('sanitizedRequest');
  });

  it('a missing record answers 404, and one logical call can be fetched whole', async () => {
    const { service, findMany, findUnique } = build();
    await expect(service.get('nope')).rejects.toBeInstanceOf(NotFoundException);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'nope' } });

    await service.byOperation('op-1');
    expect(findMany).toHaveBeenCalledWith({ where: { operationId: 'op-1' }, orderBy: { createdAt: 'asc' } });
  });

  it('the controller delegates without touching the payloads', async () => {
    const list = jest.fn().mockResolvedValue({ items: [] });
    const controller = new AdminIntegrationLogController({ list, get: jest.fn(), byOperation: jest.fn() } as unknown as IntegrationLogQueryService);
    await controller.list({ provider: IntegrationProvider.JNE } as ListIntegrationLogsQueryDto);
    expect(list).toHaveBeenCalledWith({ provider: 'JNE' });
  });
});
