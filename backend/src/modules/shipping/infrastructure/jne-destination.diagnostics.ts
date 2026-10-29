import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { JneDestinationResolver } from './jne-destination.resolver';

/** Why a district does or does not get a JNE quote - one word an operator can act on. */
export type JneDestinationVerdict =
  | 'RESOLVES'
  | 'UNKNOWN_DISTRICT'
  | 'NO_MAPPING'
  | 'NOT_APPROVED'
  | 'MAPPING_INACTIVE'
  | 'LOCATION_NOT_USABLE';

/**
 * Read-only answer to "why is JNE (not) offered for this district?", with the
 * provenance of every mapping row (status, method, confidence, reviewer, evidence).
 *
 * The verdict comes from the SAME JneDestinationResolver the checkout uses, so the
 * diagnostics can never disagree with what a customer sees; the rows only explain it.
 */
@Injectable()
export class JneDestinationDiagnostics {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: JneDestinationResolver,
  ) {}

  async forDistrictCode(districtCode: string) {
    const district = await this.prisma.district.findUnique({
      where: { code: districtCode },
      select: { id: true, code: true, name: true, isActive: true, city: { select: { name: true, type: true, isActive: true } } },
    });
    if (!district) return { districtCode, verdict: 'UNKNOWN_DISTRICT' as JneDestinationVerdict, resolvedCode: null, district: null, warnings: [], mappings: [] };

    const resolvedCode = await this.resolver.resolve(district.id);
    const rows = await this.prisma.jneDistrictMapping.findMany({
      where: { districtId: district.id },
      orderBy: { createdAt: 'asc' },
      select: {
        status: true,
        isActive: true,
        method: true,
        confidence: true,
        reviewedBy: true,
        reviewedAt: true,
        createdAt: true,
        evidence: true,
        jneLocation: { select: { code: true, kind: true, isActive: true, source: true, rawName: true } },
      },
    });

    let verdict: JneDestinationVerdict = 'RESOLVES';
    if (!resolvedCode) {
      if (rows.length === 0) verdict = 'NO_MAPPING';
      else if (!rows.some((r) => r.status === 'MATCHED')) verdict = 'NOT_APPROVED';
      else if (!rows.some((r) => r.status === 'MATCHED' && r.isActive)) verdict = 'MAPPING_INACTIVE';
      else verdict = 'LOCATION_NOT_USABLE';
    }
    // A district must resolve to ONE code. Two active approvals (only possible from data
    // written outside the manifest tools) make the resolver's pick arbitrary: flag it.
    const warnings = rows.filter((r) => r.status === 'MATCHED' && r.isActive).length > 1 ? ['MULTIPLE_ACTIVE_APPROVALS'] : [];
    return {
      districtCode,
      verdict,
      resolvedCode,
      warnings,
      district: { code: district.code, name: district.name, isActive: district.isActive, city: district.city },
      mappings: rows.map((r) => ({
        jneCode: r.jneLocation.code,
        jneRawName: r.jneLocation.rawName,
        jneKind: r.jneLocation.kind,
        jneActive: r.jneLocation.isActive,
        jneSource: r.jneLocation.source,
        status: r.status,
        isActive: r.isActive,
        method: r.method,
        confidence: r.confidence,
        reviewedBy: r.reviewedBy,
        reviewedAt: r.reviewedAt,
        createdAt: r.createdAt,
        evidence: r.evidence,
      })),
    };
  }
}
