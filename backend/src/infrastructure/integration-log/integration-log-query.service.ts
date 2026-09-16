import { Injectable, NotFoundException } from '@nestjs/common';
import { IntegrationDirection, IntegrationOutcome, IntegrationProvider, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { pageArgs, paginate } from '../../common/pagination/pagination';

export interface IntegrationLogQuery {
  page?: number;
  limit?: number;
  search?: string;
  provider?: IntegrationProvider;
  operation?: string;
  direction?: IntegrationDirection;
  applicationOutcome?: IntegrationOutcome;
  httpStatus?: number;
  operationId?: string;
  requestId?: string;
  orderId?: string;
  paymentId?: string;
  shipmentId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  sort?: 'asc' | 'desc';
}

/**
 * Read-only search + detail over IntegrationApiLog. Always paginated, newest first
 * by default. Rows are stored sanitized, so there is nothing to redact at read time
 * - and nothing here can widen what was persisted.
 */
@Injectable()
export class IntegrationLogQueryService {
  constructor(private readonly prisma: PrismaService) {}

  buildWhere(query: IntegrationLogQuery): Prisma.IntegrationApiLogWhereInput {
    const term = query.search?.trim();
    const createdAt: Prisma.DateTimeFilter = {};
    if (query.dateFrom) createdAt.gte = query.dateFrom;
    if (query.dateTo) createdAt.lte = query.dateTo;

    return {
      provider: query.provider,
      operation: query.operation,
      direction: query.direction,
      applicationOutcome: query.applicationOutcome,
      httpStatus: query.httpStatus,
      operationId: query.operationId,
      requestId: query.requestId,
      orderId: query.orderId,
      paymentId: query.paymentId,
      shipmentId: query.shipmentId,
      ...(query.dateFrom || query.dateTo ? { createdAt } : {}),
      // Free-text search stays on the identifier columns (all indexed) plus the
      // error message; payload JSON is deliberately NOT searched.
      ...(term
        ? {
            OR: [
              { errorMessage: { contains: term } },
              { operationId: term },
              { correlationId: term },
              { requestId: term },
              { orderId: term },
              { paymentId: term },
              { shipmentId: term },
              { endpoint: { contains: term } },
            ],
          }
        : {}),
    };
  }

  async list(query: IntegrationLogQuery) {
    const { skip, take, page, limit } = pageArgs(query);
    const where = this.buildWhere(query);
    const orderBy: Prisma.IntegrationApiLogOrderByWithRelationInput = { createdAt: query.sort === 'asc' ? 'asc' : 'desc' };
    const [items, total] = await Promise.all([
      this.prisma.integrationApiLog.findMany({ where, orderBy, skip, take }),
      this.prisma.integrationApiLog.count({ where }),
    ]);
    return paginate(items, total, page, limit);
  }

  async get(id: string) {
    const log = await this.prisma.integrationApiLog.findUnique({ where: { id } });
    if (!log) throw new NotFoundException('Integration log not found');
    return log;
  }

  /** Every record of ONE logical call (all attempts + the application outcome). */
  async byOperation(operationId: string) {
    return this.prisma.integrationApiLog.findMany({ where: { operationId }, orderBy: { createdAt: 'asc' } });
  }
}
