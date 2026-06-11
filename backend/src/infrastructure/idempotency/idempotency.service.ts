import { Inject, Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { IdempotencyKey, IdempotencyStatus, Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { IDEMPOTENCY_CONFIG, IdempotencyConfig } from './idempotency.config';

export interface IdempotencyContext {
  userId: string;
  key: string;
  method: string;
  endpoint: string;
  /** Canonical request projection that is hashed into the fingerprint. */
  fingerprintInput: unknown;
}

export type BeginResult =
  | { kind: 'proceed'; record: IdempotencyKey }
  | { kind: 'replay'; statusCode: number; body: Prisma.JsonValue }
  | { kind: 'processing' };

export interface FinalizeData {
  statusCode: number;
  body: Prisma.InputJsonValue;
  resourceType?: string;
  resourceId?: string;
}

/**
 * Generic, reusable idempotency over the IdempotencyKey table. The caller:
 *   1. begin(ctx)  -> reserve a key (single winner) or get a replay / 409 signal
 *   2. finalize(tx,...) inside its own write transaction (atomic with the result)
 *   3. markFailed(...) on error so the key becomes retryable
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);
  private nowMs: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(IDEMPOTENCY_CONFIG) private readonly config: IdempotencyConfig,
  ) {}

  isCheckoutEnabled(): boolean {
    return this.config.checkoutEnabled;
  }

  retryAfterSeconds(): number {
    return this.config.retryAfterSeconds;
  }

  computeFingerprint(input: unknown): string {
    return createHash('sha256').update(stableStringify(input)).digest('hex');
  }

  async begin(ctx: IdempotencyContext): Promise<BeginResult> {
    const fingerprint = this.computeFingerprint(ctx.fingerprintInput);
    const where = { userId_idempotencyKey: { userId: ctx.userId, idempotencyKey: ctx.key } };

    const existing = await this.prisma.idempotencyKey.findUnique({ where });
    if (existing) {
      const handled = await this.handleExisting(existing, fingerprint, ctx);
      if (handled) return handled;
    } else {
      try {
        const record = await this.prisma.idempotencyKey.create({
          data: {
            userId: ctx.userId,
            idempotencyKey: ctx.key,
            requestMethod: ctx.method,
            endpoint: ctx.endpoint,
            requestFingerprint: fingerprint,
            status: IdempotencyStatus.PROCESSING,
            createdAt: new Date(this.nowMs()),
            expiresAt: new Date(this.nowMs() + this.config.retentionMs),
          },
        });
        return { kind: 'proceed', record };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Concurrent reserve won the race; fall through to resolve against its row.
      }
    }

    // Single re-read to resolve a race (post-conflict, or a lost reclaim/re-reserve).
    const row = await this.prisma.idempotencyKey.findUnique({ where });
    if (!row) return { kind: 'processing' };
    const handled = await this.handleExisting(row, fingerprint, ctx);
    return handled ?? { kind: 'processing' };
  }

  /**
   * Finalize the reserved key inside the caller's transaction so the COMPLETED
   * record commits atomically with the created resource.
   */
  async finalize(tx: Prisma.TransactionClient, recordId: string, data: FinalizeData): Promise<void> {
    await tx.idempotencyKey.update({
      where: { id: recordId },
      data: {
        status: IdempotencyStatus.COMPLETED,
        responseStatusCode: data.statusCode,
        responseBody: data.body,
        resourceType: data.resourceType ?? null,
        resourceId: data.resourceId ?? null,
      },
    });
  }

  async markFailed(recordId: string, error: unknown): Promise<void> {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    try {
      await this.prisma.idempotencyKey.update({
        where: { id: recordId },
        data: { status: IdempotencyStatus.FAILED, lastError: message },
      });
    } catch (err) {
      // Best-effort; never mask the original checkout error.
      this.logger.warn(`Failed to mark idempotency ${recordId} FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleExisting(
    record: IdempotencyKey,
    fingerprint: string,
    ctx: IdempotencyContext,
  ): Promise<BeginResult | null> {
    if (record.requestFingerprint !== fingerprint) {
      throw new UnprocessableEntityException('Idempotency-Key was already used with a different request');
    }
    if (record.status === IdempotencyStatus.COMPLETED) {
      return { kind: 'replay', statusCode: record.responseStatusCode ?? 200, body: (record.responseBody ?? {}) as Prisma.JsonValue };
    }
    if (record.status === IdempotencyStatus.FAILED) {
      const claimed = await this.claim(record.id, fingerprint, ctx, 'FAILED');
      return claimed ? { kind: 'proceed', record: claimed } : null;
    }
    // PROCESSING
    if (this.isReclaimable(record)) {
      const claimed = await this.claim(record.id, fingerprint, ctx, 'STUCK');
      return claimed ? { kind: 'proceed', record: claimed } : null;
    }
    return { kind: 'processing' };
  }

  private isReclaimable(record: IdempotencyKey): boolean {
    return record.createdAt.getTime() < this.nowMs() - this.config.reclaimMs;
  }

  /** Conditional claim of a FAILED or stuck-PROCESSING row; single winner via updateMany count. */
  private async claim(
    id: string,
    fingerprint: string,
    ctx: IdempotencyContext,
    mode: 'FAILED' | 'STUCK',
  ): Promise<IdempotencyKey | null> {
    const where: Prisma.IdempotencyKeyWhereInput =
      mode === 'FAILED'
        ? { id, status: IdempotencyStatus.FAILED }
        : { id, status: IdempotencyStatus.PROCESSING, createdAt: { lt: new Date(this.nowMs() - this.config.reclaimMs) } };

    const result = await this.prisma.idempotencyKey.updateMany({
      where,
      data: {
        status: IdempotencyStatus.PROCESSING,
        requestFingerprint: fingerprint,
        requestMethod: ctx.method,
        endpoint: ctx.endpoint,
        createdAt: new Date(this.nowMs()),
        expiresAt: new Date(this.nowMs() + this.config.retentionMs),
        lastError: null,
        responseStatusCode: null,
        resourceType: null,
        resourceId: null,
      },
    });
    if (result.count !== 1) return null;
    return this.prisma.idempotencyKey.findUnique({ where: { id } });
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** Deterministic JSON with recursively sorted object keys (arrays keep order). */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeys((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}
