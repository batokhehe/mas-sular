/**
 * PAXELBOX-61E: pure transformer for JNE destination master data.
 *
 * ---------------------------------------------------------------------------
 * RAW IS AUTHORITATIVE
 *
 * `rawName` is carried through byte-for-byte. The normalised and parsed fields
 * are DERIVED COMPANIONS, never replacements. That matters because the observed
 * sandbox dataset is messy in ways that are themselves evidence: 1,370 rows have
 * spacing around the comma, 566 have leading or trailing whitespace, and one row
 * splits into three parts where two were meant (`LUBUKSIKAPING,KAB,PASAMAN`).
 * Normalising on write would erase exactly the detail a reviewer needs to judge
 * a mapping later.
 *
 * ---------------------------------------------------------------------------
 * NO I/O
 *
 * This module has no HTTP client, no filesystem access and no Prisma import, so
 * it cannot fetch, cannot write, and can be exercised entirely from a fixture.
 */

export type JneLocationKind = 'ORIGIN' | 'DESTINATION';
export type JneDataSource = 'SANDBOX' | 'PRODUCTION';

/** One row exactly as `/insert/getdestination` returns it. */
export interface JneMasterRaw {
  City_Name: string;
  City_Code: string;
}

/** A row ready to persist. `rawName` is untouched. */
export interface JneLocationSeed {
  code: string;
  rawName: string;
  normalizedName: string;
  parsedChild: string;
  parsedParent: string | null;
  partCount: number;
  kind: JneLocationKind;
  source: JneDataSource;
  sourceFetchedAt: string;
  isActive: boolean;
}

/**
 * Codes that are not real destinations. Observed verbatim in both JNE payloads
 * (production still lists TEST). An import reports them and writes neither.
 */
export const SANDBOX_TEST_CODES = ['TEST', 'XXWWQEQ'] as const;

/** JNE's real codes are three uppercase letters (an IATA hub) plus digits. */
export const JNE_CODE_PATTERN = /^[A-Z]{3}\d+$/;

export function isTestCode(code: string): boolean {
  return (SANDBOX_TEST_CODES as readonly string[]).includes(code.trim().toUpperCase());
}

/**
 * Uppercase, collapse runs of whitespace, normalise spacing around commas, trim.
 * Deliberately does NOT expand abbreviations (`KAB.`, `BRT`) or fix spelling:
 * `BANDUG` stays `BANDUG` so the typo remains visible to a reviewer.
 */
export function normalizeJneName(value: string): string {
  return value
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ',')
    .trim();
}

/**
 * Split a normalised name into child and parent.
 *
 * "CIBIRU,BANDUNG" -> child CIBIRU, parent BANDUNG
 * "BANDUNG"        -> child BANDUNG, parent null   (the 539-row city tier)
 *
 * The parent is the LAST part, not the second: `LUBUKSIKAPING,KAB,PASAMAN`
 * should read as Lubuksikaping in Kab. Pasaman, and the international rows
 * (`ANGUILA, ALL CITY, CARIBBEAN`) follow the same shape.
 */
export function parseJneName(normalized: string): { child: string; parent: string | null; partCount: number } {
  const parts = normalized
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return { child: '', parent: null, partCount: 0 };
  return {
    child: parts[0],
    parent: parts.length > 1 ? parts[parts.length - 1] : null,
    partCount: parts.length,
  };
}

export class JneMasterValidationError extends Error {
  constructor(reason: string) {
    super(`JNE master data is unusable: ${reason}`);
    this.name = 'JneMasterValidationError';
  }
}

export type JneMasterInvalidReason =
  | 'NOT_AN_OBJECT'
  | 'NO_CITY_NAME'
  | 'NO_CITY_CODE'
  | 'BLANK_CITY_NAME'
  | 'BLANK_CITY_CODE'
  | 'MALFORMED_CODE';

export interface JneMasterInvalidRow {
  row: number;
  code: string | null;
  name: string | null;
  reason: JneMasterInvalidReason;
}

/**
 * What a snapshot contains. `records` and `uniqueCodes` are separate counts on
 * purpose: equal numbers are a finding about the snapshot, not an assumption.
 */
export interface JneMasterInspection {
  records: number;
  uniqueCodes: number;
  /** Importable rows. Excludes invalid rows, known test codes and every row of a repeated code. */
  rows: JneMasterRaw[];
  duplicates: Array<{ code: string; rows: number[] }>;
  invalid: JneMasterInvalidRow[];
  /** Known non-destinations (TEST, XXWWQEQ): reported, never written. */
  testCodes: string[];
}

/**
 * Report every problem in a payload instead of stopping at the first, so a dry run
 * can show them all. A malformed ENVELOPE still throws, because there is nothing to
 * report on. Nothing here is repaired: a quietly-dropped row is indistinguishable
 * from a destination JNE genuinely does not serve, so an import refuses any snapshot
 * with an invalid or duplicate record.
 */
export function inspectJneMasterPayload(body: unknown): JneMasterInspection {
  if (!body || typeof body !== 'object') throw new JneMasterValidationError('payload is not an object');
  const detail = (body as { detail?: unknown }).detail;
  if (!Array.isArray(detail)) throw new JneMasterValidationError('`detail` is missing or not an array');
  if (detail.length === 0) throw new JneMasterValidationError('`detail` is empty');

  const positions = new Map<string, number[]>();
  const invalid: JneMasterInvalidRow[] = [];
  const testCodes: string[] = [];
  const rows: JneMasterRaw[] = [];

  detail.forEach((entry, row) => {
    if (!entry || typeof entry !== 'object') {
      invalid.push({ row, code: null, name: null, reason: 'NOT_AN_OBJECT' });
      return;
    }
    const r = entry as Record<string, unknown>;
    const code = typeof r.City_Code === 'string' ? r.City_Code : null;
    const name = typeof r.City_Name === 'string' ? r.City_Name : null;
    if (code !== null && code.trim()) positions.set(code, [...(positions.get(code) ?? []), row]);

    const reason: JneMasterInvalidReason | null =
      name === null ? 'NO_CITY_NAME'
      : code === null ? 'NO_CITY_CODE'
      : !name.trim() ? 'BLANK_CITY_NAME'
      : !code.trim() ? 'BLANK_CITY_CODE'
      : null;
    if (reason) {
      invalid.push({ row, code, name, reason });
      return;
    }
    const c = code as string;
    if (isTestCode(c)) {
      if (!testCodes.includes(c)) testCodes.push(c);
      return;
    }
    if (!JNE_CODE_PATTERN.test(c)) {
      invalid.push({ row, code: c, name, reason: 'MALFORMED_CODE' });
      return;
    }
    rows.push({ City_Name: name as string, City_Code: c });
  });

  return {
    records: detail.length,
    uniqueCodes: positions.size,
    // No occurrence of a repeated code survives: which one is right is not knowable here.
    rows: rows.filter((r) => (positions.get(r.City_Code) as number[]).length === 1),
    duplicates: [...positions].filter(([, at]) => at.length > 1).map(([code, at]) => ({ code, rows: at })),
    invalid,
    testCodes,
  };
}

export interface TransformOptions {
  kind?: JneLocationKind;
  /** Required: a row's environment is stated, never assumed. */
  source: JneDataSource;
  sourceFetchedAt: string;
}

/**
 * Raw rows -> persistable seeds. Pure and total.
 *
 * A row is INACTIVE when its code is a known test code or does not look like a JNE
 * code at all. `inspectJneMasterPayload` keeps such rows from an import; this flag
 * means a seed built any other way can still never be active.
 */
export function toJneLocationSeeds(rows: JneMasterRaw[], options: TransformOptions): JneLocationSeed[] {
  const kind = options.kind ?? 'DESTINATION';
  const { source } = options;
  return rows.map((r) => {
    const normalizedName = normalizeJneName(r.City_Name);
    const { child, parent, partCount } = parseJneName(normalizedName);
    const code = r.City_Code;
    return {
      code,
      rawName: r.City_Name, // VERBATIM - never trimmed, never rewritten
      normalizedName,
      parsedChild: child,
      parsedParent: parent,
      partCount,
      kind,
      source,
      sourceFetchedAt: options.sourceFetchedAt,
      isActive: !isTestCode(code) && JNE_CODE_PATTERN.test(code),
    };
  });
}
