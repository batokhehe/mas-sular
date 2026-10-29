/**
 * Reviewed JNE destination mappings, in bulk, from an explicit manifest.
 *
 * A manifest is a CSV a person can read and diff: one row per internal district,
 * naming the JNE destination code it should resolve to, why, how confident the
 * evidence is, and which dataset (and version) the evidence came from. This module
 * is the PURE part - parsing and every validation rule - so the whole decision is
 * testable offline; the CLIs only load rows and write the accepted ones.
 *
 * What it produces is a CANDIDATE: status REVIEW_REQUIRED, method MANUAL. It never
 * approves. Approval is approve-jne-mappings.ts, a separate run that names a
 * reviewer, and the runtime resolver ignores anything not MATCHED.
 *
 * It refuses rather than chooses:
 *   - a district named twice with different codes (the manifest is ambiguous);
 *   - an unknown or inactive district/city;
 *   - a code absent from the JNE master, present only as ORIGIN, or inactive;
 *   - a district already approved for a different code, or with a different
 *     pending candidate (approval promotes a district's pending rows, so a second
 *     one must never exist);
 *   - a row whose evidence or rationale is missing, or whose confidence is not a
 *     reviewable level (AMBIGUOUS is resolved before it reaches a manifest).
 * Re-running the same manifest is a no-op for rows already pending or approved.
 */
import { parseCsvRecords } from './csv';
import { jneParentForCity, type MappingEvidence } from './jne-district-mapping';

export const MANIFEST_COLUMNS = [
  'district_code',
  'jne_code',
  'confidence',
  'source_dataset',
  'source_version',
  'evidence',
  'rationale',
] as const;

/** Reviewable confidence levels. Confidence is evidence strength, never approval. */
export const MANIFEST_CONFIDENCE = ['STRONG', 'HIGH', 'MEDIUM', 'MANUAL'] as const;
export type ManifestConfidence = (typeof MANIFEST_CONFIDENCE)[number];

export const RATIONALE_MIN = 20;
const DISTRICT_CODE = /^\d{2}\.\d{2}\.\d{2}$/;
const JNE_CODE = /^[A-Z]{3}\d{5}$/;

export interface ManifestEntry {
  record: number;
  districtCode: string;
  jneCode: string;
  confidence: string;
  sourceDataset: string;
  sourceVersion: string;
  evidence: string;
  rationale: string;
}

export function parseManifest(text: string): ManifestEntry[] {
  const { records } = parseCsvRecords(text, MANIFEST_COLUMNS);
  return records.map(({ record, values: v }) => ({
    record,
    districtCode: v.district_code.trim(),
    jneCode: v.jne_code.trim().toUpperCase(),
    confidence: v.confidence.trim().toUpperCase(),
    sourceDataset: v.source_dataset.trim(),
    sourceVersion: v.source_version.trim(),
    evidence: v.evidence.trim(),
    rationale: v.rationale.trim(),
  }));
}

// ------------------------------------------------------------------ context

export interface ManifestDistrict {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  city: { id: string; name: string; type: string; isActive: boolean; province: { id: string; name: string } };
}

export interface ManifestLocation {
  id: string;
  code: string;
  kind: string;
  source: string;
  isActive: boolean;
  rawName: string;
  parsedChild: string;
  parsedParent: string | null;
}

export interface ExistingMapping {
  districtId: string;
  jneLocationId: string;
  jneCode: string;
  status: string;
  isActive: boolean;
}

export interface ManifestContext {
  districts: Map<string, ManifestDistrict>; // by district code
  locations: ManifestLocation[]; // every kind, so ORIGIN-only is reported as such
  existing: ExistingMapping[];
  /** JneLocation.source values accepted as a mapping target. */
  allowedSources: readonly string[];
  /** Identifies the manifest file itself (e.g. its sha256), stored as provenance. */
  manifestId: string;
  now: () => string;
}

// ------------------------------------------------------------------ results

export type RejectReason =
  | 'MALFORMED_ROW'
  | 'INVALID_CONFIDENCE'
  | 'MISSING_PROVENANCE'
  | 'RATIONALE_TOO_SHORT'
  | 'DUPLICATE_ROW'
  | 'CONFLICTING_ROWS'
  | 'UNKNOWN_DISTRICT'
  | 'INACTIVE_DISTRICT'
  | 'JNE_CODE_NOT_IN_MASTER'
  | 'JNE_CODE_ORIGIN_ONLY'
  | 'JNE_LOCATION_INACTIVE'
  | 'JNE_SOURCE_NOT_ALLOWED'
  | 'APPROVED_FOR_DIFFERENT_CODE'
  | 'PENDING_FOR_DIFFERENT_CODE'
  | 'EXISTING_ROW_NOT_REUSABLE';

export type NoopReason = 'ALREADY_PENDING' | 'ALREADY_APPROVED';

export interface CandidateWrite {
  districtId: string;
  jneLocationId: string;
  status: 'REVIEW_REQUIRED';
  method: 'MANUAL';
  confidence: ManifestConfidence;
  evidence: MappingEvidence & ManifestProvenance;
  notes: string;
}

export interface ManifestProvenance {
  manifestId: string;
  manifestRecord: number;
  sourceDataset: string;
  sourceVersion: string;
  evidenceSummary: string;
  confidence: ManifestConfidence;
}

export type RowOutcome =
  | { entry: ManifestEntry; outcome: 'ACCEPT'; write: CandidateWrite }
  | { entry: ManifestEntry; outcome: 'NOOP'; reason: NoopReason }
  | { entry: ManifestEntry; outcome: 'REJECT'; reason: RejectReason; detail: string };

export interface ManifestReport {
  rows: RowOutcome[];
  accepted: number;
  noop: number;
  rejected: number;
  byReason: Record<string, number>;
}

// ------------------------------------------------------------------ validation

function reject(entry: ManifestEntry, reason: RejectReason, detail: string): RowOutcome {
  return { entry, outcome: 'REJECT', reason, detail };
}

function shapeProblem(e: ManifestEntry): RowOutcome | null {
  if (!DISTRICT_CODE.test(e.districtCode)) return reject(e, 'MALFORMED_ROW', `district_code "${e.districtCode}" is not NN.NN.NN`);
  if (!JNE_CODE.test(e.jneCode)) return reject(e, 'MALFORMED_ROW', `jne_code "${e.jneCode}" is not AAA99999`);
  if (!(MANIFEST_CONFIDENCE as readonly string[]).includes(e.confidence)) {
    return reject(e, 'INVALID_CONFIDENCE', `confidence "${e.confidence}" is not one of ${MANIFEST_CONFIDENCE.join('/')}`);
  }
  if (!e.sourceDataset || !e.sourceVersion || !e.evidence) {
    return reject(e, 'MISSING_PROVENANCE', 'source_dataset, source_version and evidence are all required');
  }
  if (e.rationale.length < RATIONALE_MIN) return reject(e, 'RATIONALE_TOO_SHORT', `rationale must be at least ${RATIONALE_MIN} characters`);
  return null;
}

/**
 * Decide every row. Deterministic: rows are evaluated and returned in district-code
 * order (then manifest order), so the same manifest always yields the same report.
 */
export function validateManifest(entries: ManifestEntry[], ctx: ManifestContext): ManifestReport {
  const sorted = [...entries].sort((a, b) => a.districtCode.localeCompare(b.districtCode) || a.record - b.record);

  // Manifest-level ambiguity first: one district, several codes -> every row refused.
  const codesByDistrict = new Map<string, Set<string>>();
  for (const e of sorted) {
    if (!codesByDistrict.has(e.districtCode)) codesByDistrict.set(e.districtCode, new Set());
    codesByDistrict.get(e.districtCode)!.add(e.jneCode);
  }

  const destByCode = new Map<string, ManifestLocation>();
  const kindsByCode = new Map<string, Set<string>>();
  for (const l of ctx.locations) {
    if (!kindsByCode.has(l.code)) kindsByCode.set(l.code, new Set());
    kindsByCode.get(l.code)!.add(l.kind);
    if (l.kind === 'DESTINATION') destByCode.set(l.code, l);
  }
  const existingByDistrict = new Map<string, ExistingMapping[]>();
  for (const m of ctx.existing) {
    if (!existingByDistrict.has(m.districtId)) existingByDistrict.set(m.districtId, []);
    existingByDistrict.get(m.districtId)!.push(m);
  }

  const seenPairs = new Set<string>();
  const rows: RowOutcome[] = sorted.map((e): RowOutcome => {
    const bad = shapeProblem(e);
    if (bad) return bad;

    const codes = codesByDistrict.get(e.districtCode)!;
    if (codes.size > 1) return reject(e, 'CONFLICTING_ROWS', `district listed with ${[...codes].sort().join(', ')}`);
    const pair = `${e.districtCode}|${e.jneCode}`;
    if (seenPairs.has(pair)) return reject(e, 'DUPLICATE_ROW', `same district and code already on an earlier row`);
    seenPairs.add(pair);

    const d = ctx.districts.get(e.districtCode);
    if (!d) return reject(e, 'UNKNOWN_DISTRICT', `no district ${e.districtCode}`);
    if (!d.isActive || !d.city.isActive) return reject(e, 'INACTIVE_DISTRICT', `${d.name} (${d.city.name}) is inactive`);

    const loc = destByCode.get(e.jneCode);
    if (!loc) {
      return kindsByCode.get(e.jneCode)?.has('ORIGIN')
        ? reject(e, 'JNE_CODE_ORIGIN_ONLY', `${e.jneCode} exists only as an ORIGIN`)
        : reject(e, 'JNE_CODE_NOT_IN_MASTER', `${e.jneCode} is not a DESTINATION in the JNE master`);
    }
    if (!loc.isActive) return reject(e, 'JNE_LOCATION_INACTIVE', `${e.jneCode} is inactive`);
    if (!ctx.allowedSources.includes(loc.source)) {
      return reject(e, 'JNE_SOURCE_NOT_ALLOWED', `${e.jneCode} comes from ${loc.source}; allowed: ${ctx.allowedSources.join(', ')}`);
    }

    const existing = existingByDistrict.get(d.id) ?? [];
    const samePair = existing.find((m) => m.jneLocationId === loc.id);
    if (samePair?.status === 'MATCHED' && samePair.isActive) return { entry: e, outcome: 'NOOP', reason: 'ALREADY_APPROVED' };
    const approvedOther = existing.find((m) => m.status === 'MATCHED' && m.isActive && m.jneLocationId !== loc.id);
    if (approvedOther) return reject(e, 'APPROVED_FOR_DIFFERENT_CODE', `already approved for ${approvedOther.jneCode}`);
    if (samePair?.status === 'REVIEW_REQUIRED' && samePair.isActive) return { entry: e, outcome: 'NOOP', reason: 'ALREADY_PENDING' };
    const pendingOther = existing.find((m) => m.status === 'REVIEW_REQUIRED' && m.jneLocationId !== loc.id);
    if (pendingOther) return reject(e, 'PENDING_FOR_DIFFERENT_CODE', `already has a pending candidate ${pendingOther.jneCode}`);
    // An inactive, AMBIGUOUS or NOT_FOUND row for this exact pair occupies the unique
    // key; reviving it is a deliberate decision, not something a manifest does.
    if (samePair) return reject(e, 'EXISTING_ROW_NOT_REUSABLE', `existing ${samePair.status}${samePair.isActive ? '' : ' (inactive)'} row for this pair`);

    return { entry: e, outcome: 'ACCEPT', write: candidateWrite(e, d, loc, ctx) };
  });

  const byReason: Record<string, number> = {};
  for (const r of rows) {
    const key = r.outcome === 'ACCEPT' ? 'ACCEPT' : r.reason;
    byReason[key] = (byReason[key] ?? 0) + 1;
  }
  return {
    rows,
    accepted: rows.filter((r) => r.outcome === 'ACCEPT').length,
    noop: rows.filter((r) => r.outcome === 'NOOP').length,
    rejected: rows.filter((r) => r.outcome === 'REJECT').length,
    byReason,
  };
}

function candidateWrite(e: ManifestEntry, d: ManifestDistrict, loc: ManifestLocation, ctx: ManifestContext): CandidateWrite {
  const cityType = d.city.type === 'CITY' ? 'CITY' : 'REGENCY';
  const confidence = e.confidence as ManifestConfidence;
  return {
    districtId: d.id,
    jneLocationId: loc.id,
    status: 'REVIEW_REQUIRED',
    method: 'MANUAL',
    confidence,
    notes: `manifest ${ctx.manifestId} record ${e.record}: ${d.name} (${d.city.name}) -> ${loc.code} ${loc.rawName}; awaiting approval`,
    evidence: {
      // The same keys every generated candidate carries, so existing tooling and
      // reviewers read a manual row exactly like a name-matched one...
      internalDistrictId: d.id,
      internalDistrictName: d.name,
      internalCityId: d.city.id,
      internalCityName: d.city.name,
      internalCityType: d.city.type,
      internalProvinceId: d.city.province.id,
      internalProvinceName: d.city.province.name,
      jneLocationId: loc.id,
      jneCode: loc.code,
      jneRawName: loc.rawName,
      jneParsedChild: loc.parsedChild,
      jneParsedParent: loc.parsedParent,
      candidateCount: 1,
      candidateCodes: [loc.code],
      matchingMethod: 'MANUAL',
      aliasRationale: e.rationale,
      expectedJneParent: jneParentForCity(d.city.name, cityType),
      acceptedJneParents: loc.parsedParent ? [loc.parsedParent] : [],
      aliasTransformation: null,
      resolvedAt: ctx.now(),
      // ...plus where this row came from.
      manifestId: ctx.manifestId,
      manifestRecord: e.record,
      sourceDataset: e.sourceDataset,
      sourceVersion: e.sourceVersion,
      evidenceSummary: e.evidence,
      confidence,
    },
  };
}

/** Flat rows for a dry-run / write report CSV. */
export function reportRows(report: ManifestReport): Array<Record<string, string | number>> {
  return report.rows.map((r) => ({
    record: r.entry.record,
    district_code: r.entry.districtCode,
    jne_code: r.entry.jneCode,
    confidence: r.entry.confidence,
    outcome: r.outcome,
    reason: r.outcome === 'ACCEPT' ? '' : r.reason,
    detail: r.outcome === 'REJECT' ? r.detail : '',
  }));
}
