import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../../database/prisma.service';
import { AuditQueryDto } from '../application/dto/audit-query.dto';

@ApiTags('audit')
@Controller({ path: 'audit-logs', version: '1' })
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list(@Query() query: AuditQueryDto) {
    return this.prisma.auditLog.findMany({
      where: { entity: query.entity },
      include: { actor: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
}
