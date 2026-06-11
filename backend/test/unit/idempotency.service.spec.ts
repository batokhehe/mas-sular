import { UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IdempotencyService } from '../../src/infrastructure/idempotency/idempotency.service';
import { IdempotencyConfig } from '../../src/infrastructure/idempotency/idempotency.config';

const NOW = 2_000_000_000_000;

const config: IdempotencyConfig = {
  checkoutEnabled: true,
  retentionMs: 48 * 60 * 60 * 1000,
  reclaimMs: 120 * 1000,
  retryAfterSeconds: 2,
};

function buildPrisma() {
  return {
    idempotencyKey: {
      findUnique: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
  };
}

function build() {
  const prisma = buildPrisma();
  const service = new IdempotencyService(prisma as any, config);
  (service as any).nowMs = () => NOW;
  return { service, prisma };
}

const CTX = {
  userId: 'user-1',
  key: 'key-abc',
  method: 'POST',
  endpoint: '/checkout/order',
  fingerprintInput: { body: { a: 1, items: [{ x: 1 }] } },
};

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.19.3',
  });
}

describe('IdempotencyService', () => {
  describe('computeFingerprint', () => {
    it('is stable under object key reordering', () => {
      const { service } = build();
      expect(service.computeFingerprint({ a: 1, b: 2 })).toBe(service.computeFingerprint({ b: 2, a: 1 }));
    });

    it('changes when a value changes', () => {
      const { service } = build();
      expect(service.computeFingerprint({ a: 1 })).not.toBe(service.computeFingerprint({ a: 2 }));
    });
  });

  describe('begin', () => {
    it('reserves a fresh key (PROCESSING) and returns proceed', async () => {
      const { service, prisma } = build();
      prisma.idempotencyKey.findUnique.mockResolvedValue(null);
      prisma.idempotencyKey.create.mockResolvedValue({ id: 'rec-1', status: 'PROCESSING' });

      const result = await service.begin(CTX);

      expect(result).toEqual({ kind: 'proceed', record: { id: 'rec-1', status: 'PROCESSING' } });
      expect(prisma.idempotencyKey.create).toHaveBeenCalledTimes(1);
    });

    it('replays a COMPLETED record', async () => {
      const { service, prisma } = build();
      const fp = service.computeFingerprint(CTX.fingerprintInput);
      prisma.idempotencyKey.findUnique.mockResolvedValue({
        id: 'rec-1',
        requestFingerprint: fp,
        status: 'COMPLETED',
        responseStatusCode: 201,
        responseBody: { id: 'order-1' },
      });

      const result = await service.begin(CTX);

      expect(result).toEqual({ kind: 'replay', statusCode: 201, body: { id: 'order-1' } });
      expect(prisma.idempotencyKey.create).not.toHaveBeenCalled();
    });

    it('returns processing for a fresh in-flight PROCESSING record', async () => {
      const { service, prisma } = build();
      const fp = service.computeFingerprint(CTX.fingerprintInput);
      prisma.idempotencyKey.findUnique.mockResolvedValue({
        id: 'rec-1',
        requestFingerprint: fp,
        status: 'PROCESSING',
        createdAt: new Date(NOW - 1_000), // within reclaim window
      });

      expect(await service.begin(CTX)).toEqual({ kind: 'processing' });
    });

    it('throws 422 on fingerprint mismatch', async () => {
      const { service, prisma } = build();
      prisma.idempotencyKey.findUnique.mockResolvedValue({
        id: 'rec-1',
        requestFingerprint: 'a-different-hash',
        status: 'COMPLETED',
      });

      await expect(service.begin(CTX)).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('resolves a concurrent reserve conflict to processing', async () => {
      const { service, prisma } = build();
      const fp = service.computeFingerprint(CTX.fingerprintInput);
      prisma.idempotencyKey.findUnique
        .mockResolvedValueOnce(null) // first lookup: nothing
        .mockResolvedValueOnce({ id: 'rec-1', requestFingerprint: fp, status: 'PROCESSING', createdAt: new Date(NOW) }); // after conflict
      prisma.idempotencyKey.create.mockRejectedValue(uniqueViolation());

      expect(await service.begin(CTX)).toEqual({ kind: 'processing' });
    });

    it('re-reserves a FAILED record and proceeds', async () => {
      const { service, prisma } = build();
      const fp = service.computeFingerprint(CTX.fingerprintInput);
      prisma.idempotencyKey.findUnique
        .mockResolvedValueOnce({ id: 'rec-1', requestFingerprint: fp, status: 'FAILED', createdAt: new Date(NOW) })
        .mockResolvedValueOnce({ id: 'rec-1', status: 'PROCESSING' });
      prisma.idempotencyKey.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.begin(CTX);

      expect(prisma.idempotencyKey.updateMany).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ kind: 'proceed', record: { id: 'rec-1', status: 'PROCESSING' } });
    });

    it('reclaims a stuck PROCESSING record (older than reclaim window)', async () => {
      const { service, prisma } = build();
      const fp = service.computeFingerprint(CTX.fingerprintInput);
      prisma.idempotencyKey.findUnique
        .mockResolvedValueOnce({ id: 'rec-1', requestFingerprint: fp, status: 'PROCESSING', createdAt: new Date(NOW - 200_000) })
        .mockResolvedValueOnce({ id: 'rec-1', status: 'PROCESSING' });
      prisma.idempotencyKey.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.begin(CTX);

      expect(result.kind).toBe('proceed');
      // claim guarded on the stuck window
      expect(prisma.idempotencyKey.updateMany.mock.calls[0][0].where).toEqual(
        expect.objectContaining({ id: 'rec-1', status: 'PROCESSING' }),
      );
    });

    it('returns processing when a reclaim race is lost', async () => {
      const { service, prisma } = build();
      const fp = service.computeFingerprint(CTX.fingerprintInput);
      prisma.idempotencyKey.findUnique.mockResolvedValue({
        id: 'rec-1',
        requestFingerprint: fp,
        status: 'PROCESSING',
        createdAt: new Date(NOW - 200_000),
      });
      prisma.idempotencyKey.updateMany.mockResolvedValue({ count: 0 }); // someone else claimed

      expect(await service.begin(CTX)).toEqual({ kind: 'processing' });
    });
  });

  describe('finalize / markFailed', () => {
    it('finalize writes COMPLETED via the provided tx client', async () => {
      const { service } = build();
      const tx = { idempotencyKey: { update: jest.fn().mockResolvedValue({}) } };

      await service.finalize(tx as any, 'rec-1', { statusCode: 201, body: { id: 'order-1' }, resourceType: 'Order', resourceId: 'order-1' });

      expect(tx.idempotencyKey.update).toHaveBeenCalledWith({
        where: { id: 'rec-1' },
        data: expect.objectContaining({ status: 'COMPLETED', responseStatusCode: 201, resourceId: 'order-1' }),
      });
    });

    it('markFailed sets FAILED and swallows errors', async () => {
      const { service, prisma } = build();
      prisma.idempotencyKey.update.mockRejectedValue(new Error('db down'));

      await expect(service.markFailed('rec-1', new Error('boom'))).resolves.toBeUndefined();
      expect(prisma.idempotencyKey.update).toHaveBeenCalledWith({
        where: { id: 'rec-1' },
        data: expect.objectContaining({ status: 'FAILED', lastError: 'boom' }),
      });
    });
  });
});
