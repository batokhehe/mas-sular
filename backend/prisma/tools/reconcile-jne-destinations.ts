/**
 * Reconcile a JNE destination list (list_dest: one row per kelurahan with its
 * tariff code) against our region master and the imported JNE master, OFFLINE.
 *
 * It reads files only - no database, no JNE call - and writes reviewable output:
 *   manifest-strong.csv, manifest-high.csv, manifest-medium.csv
 *       candidate manifests for import-jne-mapping-manifest.ts (still REVIEW_REQUIRED
 *       after import; confidence is evidence strength, never approval)
 *   exceptions.csv          every district that must NOT be proposed, and why
 *   sheet-codes-not-in-master.csv   tariff codes the JNE master does not contain
 *   districts.csv           one line per active district, with its classification
 *   summary.json            counts, nationwide and per province
 *
 * EVIDENCE RULE. A list row supports a district only when its kelurahan name AND
 * postal code equal one of that district's villages (names compared upper-cased with
 * spaces/punctuation removed - "BOJONG SOANG" = "Bojongsoang" - nothing fuzzier). A
 * district or city NAME is never proof: CITY_NAME does not separate Kota from
 * Kabupaten ("BANDUNG" covers both). Several plausible codes are never resolved by
 * picking one; a code missing from the JNE master is never invented.
 *
 * Inputs (UTF-8 CSV, header row):
 *   --sheet      COUNTRY_NAME,PROVINCE_NAME,CITY_NAME,DISTRICT_NAME,SUBDISTRICT_NAME,ZIP_CODE,TARIFF_CODE
 *   --districts  district_code,district,d_active,city_code,city,city_type,c_active,province_code,province
 *   --villages   village_code,district_code,village,postal_code,v_active
 *   --locations  code,kind,source,active,raw_name,parsed_child,parsed_parent,fetched_at
 *   --mappings   district_code,jne_code,kind,loc_active,status,m_active,method
 * The last four are read-only exports of District/City/Province, Village, JneLocation
 * and JneDistrictMapping (booleans as t/f, as psql writes them).
 */
import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseCsvRecords, toCsv } from './csv';

export const SHEET_COLUMNS = ['PROVINCE_NAME', 'CITY_NAME', 'DISTRICT_NAME', 'SUBDISTRICT_NAME', 'ZIP_CODE', 'TARIFF_CODE'] as const;

export const norm = (s: string | null | undefined): string => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * The list's province labels that are not simply our province's name, mapped to the
 * province(s) they mean. Reviewed DATA, never a rule: any other label must equal our
 * name exactly (after norm). No substring or shared-word matching - that is how RIAU
 * once matched Kepulauan Riau, MALUKU matched Maluku Utara, and "TENGGARA" made
 * Sulawesi Tenggara match both Nusa Tenggara provinces.
 *
 * PAPUA and PAPUA BARAT predate the 2022 provinces carved out of them; the list still
 * files those districts under the old label, so the old label admits the new
 * provinces. Village name + postal code still decides which district a row is.
 */
export const PROVINCE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'NANGGROE ACEH DARUSSALAM (NAD)': ['Aceh'],
  'DI YOGYAKARTA': ['Daerah Istimewa Yogyakarta'],
  'DKI JAKARTA': ['Daerah Khusus Ibukota Jakarta'],
  'BANGKA BELITUNG': ['Kepulauan Bangka Belitung'],
  'NUSA TENGGARA BARAT (NTB)': ['Nusa Tenggara Barat'],
  'NUSA TENGGARA TIMUR (NTT)': ['Nusa Tenggara Timur'],
  PAPUA: ['Papua', 'Papua Pegunungan', 'Papua Selatan', 'Papua Tengah'],
  'PAPUA BARAT': ['Papua Barat', 'Papua Barat Daya'],
};
const ALIASES_BY_NORM = new Map(Object.entries(PROVINCE_ALIASES).map(([k, v]) => [norm(k), new Set(v.map(norm))]));

/** Filter only: a list row from another province is never the same place. */
export function sameProvince(sheetProvince: string, internalProvince: string): boolean {
  const a = norm(sheetProvince);
  const b = norm(internalProvince);
  if (!a || !b) return false;
  return a === b || (ALIASES_BY_NORM.get(a)?.has(b) ?? false);
}

export interface SheetRow {
  province: string;
  city: string;
  district: string;
  subdistrict: string;
  zip: string;
  code: string;
}
export interface DistrictRow {
  code: string;
  name: string;
  active: boolean;
  cityCode: string;
  city: string;
  cityType: string;
  province: string;
}
export interface VillageRow {
  code: string;
  districtCode: string;
  name: string;
  postalCode: string;
  active: boolean;
}
export interface LocationRow {
  code: string;
  kind: string;
  source: string;
  active: boolean;
  rawName: string;
  parsedChild: string;
}
export interface MappingRow {
  districtCode: string;
  jneCode: string;
  kind: string;
  locationActive: boolean;
  status: string;
  active: boolean;
}

export type DistrictClass =
  | 'MAPPED_VERIFIED'
  | 'MAPPED_MISMATCH'
  | 'MAPPED_UNVERIFIED'
  | 'MAPPED_AMBIGUOUS_EVIDENCE'
  | 'EXISTING_NOT_USABLE'
  | 'CANDIDATE_STRONG'
  | 'CANDIDATE_HIGH'
  | 'CANDIDATE_MEDIUM'
  | 'AMBIGUOUS'
  | 'CODE_NOT_IN_MASTER'
  | 'NO_EVIDENCE';

export interface DistrictResult {
  district: DistrictRow;
  villages: number;
  villagesMatched: number;
  codeVotes: Array<[string, number]>;
  districtNameAgrees: [number, number];
  candidateCode: string | null;
  master: string;
  mapping: string;
  klass: DistrictClass;
  evidence: string;
}

export interface ReconcileInput {
  sheet: SheetRow[];
  districts: DistrictRow[];
  villages: VillageRow[];
  locations: LocationRow[];
  mappings: MappingRow[];
}

export interface ReconcileOutput {
  results: DistrictResult[];
  sheetCodesNotInMaster: Array<{ code: string; rows: number; originOnly: boolean }>;
  masterDestinationsNotInSheet: number;
  sheetCodes: number;
  ambiguousCityNames: Array<{ sheetCity: string; internalCities: string[] }>;
  /** List rows whose province label matches none of ours: reported, never guessed at. */
  unrecognizedProvinces: Array<{ province: string; rows: number }>;
}

/** The decision for every active district. Pure and deterministic (district-code order). */
export function reconcileDestinations(input: ReconcileInput): ReconcileOutput {
  const dest = new Map<string, LocationRow>();
  const origin = new Set<string>();
  for (const l of input.locations) {
    if (l.kind === 'DESTINATION') dest.set(l.code, l);
    else if (l.kind === 'ORIGIN') origin.add(l.code);
  }

  const rowsPerCode = new Map<string, number>();
  const byKey = new Map<string, SheetRow[]>();
  for (const r of input.sheet) {
    rowsPerCode.set(r.code, (rowsPerCode.get(r.code) ?? 0) + 1);
    if (!/^\d{5}$/.test(r.zip)) continue;
    const k = `${norm(r.subdistrict)}|${r.zip}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(r);
  }
  const villagesOf = new Map<string, VillageRow[]>();
  for (const v of input.villages) {
    if (!v.active) continue;
    if (!villagesOf.has(v.districtCode)) villagesOf.set(v.districtCode, []);
    villagesOf.get(v.districtCode)!.push(v);
  }
  const mappingsOf = new Map<string, MappingRow[]>();
  for (const m of input.mappings) {
    if (!mappingsOf.has(m.districtCode)) mappingsOf.set(m.districtCode, []);
    mappingsOf.get(m.districtCode)!.push(m);
  }
  const cityLanding = new Map<string, Set<string>>();

  const results: DistrictResult[] = [...input.districts]
    .filter((d) => d.active)
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((d): DistrictResult => {
      const vs = (villagesOf.get(d.code) ?? []).filter((v) => /^\d{5}$/.test(v.postalCode));
      const votes = new Map<string, Set<string>>();
      let matched = 0;
      let nameAgree = 0;
      let nameRows = 0;
      for (const v of vs) {
        const hits = (byKey.get(`${norm(v.name)}|${v.postalCode}`) ?? []).filter((r) => sameProvince(r.province, d.province));
        if (hits.length === 0) continue;
        matched++;
        for (const r of hits) {
          if (!votes.has(r.code)) votes.set(r.code, new Set());
          votes.get(r.code)!.add(v.code);
          nameRows++;
          if (norm(r.district) === norm(d.name)) nameAgree++;
          const ck = `${r.province}/${r.city}`;
          if (!cityLanding.has(ck)) cityLanding.set(ck, new Set());
          cityLanding.get(ck)!.add(`${d.city} [${d.cityType}]`);
        }
      }
      const codeVotes = [...votes.entries()].map(([c, s]): [string, number] => [c, s.size]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const single = codeVotes.length === 1 ? codeVotes[0][0] : null;
      const loc = single ? dest.get(single) : undefined;
      const master = loc ? `${loc.rawName.replace(/\s+/g, ' ')} [${loc.kind}${loc.active ? '' : ',inactive'},${loc.source}]` : single ? 'NOT_IN_MASTER' : '';
      const evidence =
        `kelurahan+postal ${matched}/${vs.length} matched` +
        (codeVotes.length ? `; codes ${codeVotes.map(([c, n]) => `${c}:${n}`).join(' ')}` : '') +
        (nameRows ? `; list district name agrees ${nameAgree}/${nameRows}` : '') +
        (master ? `; JNE master ${master}` : '');

      const base = {
        district: d,
        villages: vs.length,
        villagesMatched: matched,
        codeVotes,
        districtNameAgrees: [nameAgree, nameRows] as [number, number],
        master,
        evidence,
      };

      const ms = mappingsOf.get(d.code) ?? [];
      const usable = ms.find((m) => m.status === 'MATCHED' && m.active && m.kind === 'DESTINATION' && m.locationActive);
      if (usable) {
        const mapping = `MATCHED ${usable.jneCode}`;
        const klass: DistrictClass =
          codeVotes.length === 0
            ? 'MAPPED_UNVERIFIED'
            : single === usable.jneCode
              ? 'MAPPED_VERIFIED'
              : codeVotes.some(([c]) => c === usable.jneCode)
                ? 'MAPPED_AMBIGUOUS_EVIDENCE'
                : 'MAPPED_MISMATCH';
        return { ...base, candidateCode: usable.jneCode, mapping, klass };
      }
      if (ms.length) {
        const mapping = ms.map((m) => `${m.status}${m.active ? '' : '/inactive'} ${m.jneCode}`).join('; ');
        return { ...base, candidateCode: single, mapping, klass: 'EXISTING_NOT_USABLE' };
      }

      let klass: DistrictClass;
      if (codeVotes.length === 0) klass = 'NO_EVIDENCE';
      else if (codeVotes.length > 1) klass = 'AMBIGUOUS';
      else if (!loc || !loc.active) klass = 'CODE_NOT_IN_MASTER';
      else {
        const covered = matched >= 2 && matched / Math.max(1, vs.length) >= 0.5;
        const namesAgree = norm(loc.parsedChild) === norm(d.name) && nameRows > 0 && nameAgree === nameRows;
        klass = !covered ? 'CANDIDATE_MEDIUM' : namesAgree ? 'CANDIDATE_STRONG' : 'CANDIDATE_HIGH';
      }
      return { ...base, candidateCode: single, mapping: '', klass };
    });

  const internalProvinces = [...new Set(input.districts.map((d) => d.province))];
  const unrecognized = new Map<string, number>();
  for (const r of input.sheet) {
    if (!internalProvinces.some((p) => sameProvince(r.province, p))) unrecognized.set(r.province, (unrecognized.get(r.province) ?? 0) + 1);
  }

  const sheetCodesNotInMaster = [...rowsPerCode.entries()]
    .filter(([c]) => !dest.has(c))
    .map(([code, rows]) => ({ code, rows, originOnly: origin.has(code) }))
    .sort((a, b) => a.code.localeCompare(b.code));
  return {
    results,
    sheetCodesNotInMaster,
    masterDestinationsNotInSheet: [...dest.keys()].filter((c) => !rowsPerCode.has(c)).length,
    sheetCodes: rowsPerCode.size,
    unrecognizedProvinces: [...unrecognized.entries()].map(([province, rows]) => ({ province, rows })).sort((a, b) => a.province.localeCompare(b.province)),
    ambiguousCityNames: [...cityLanding.entries()]
      .filter(([, s]) => s.size > 1)
      .map(([sheetCity, s]) => ({ sheetCity, internalCities: [...s].sort() }))
      .sort((a, b) => a.sheetCity.localeCompare(b.sheetCity)),
  };
}

const TIER_CONFIDENCE: Partial<Record<DistrictClass, string>> = {
  CANDIDATE_STRONG: 'STRONG',
  CANDIDATE_HIGH: 'HIGH',
  CANDIDATE_MEDIUM: 'MEDIUM',
};
const TIER_RATIONALE: Partial<Record<DistrictClass, string>> = {
  CANDIDATE_STRONG: 'One tariff code for every matched kelurahan+postal code; JNE master and list both name this district. Needs human review before approval.',
  CANDIDATE_HIGH: 'One tariff code for the matched kelurahan+postal codes, but the district name differs between sources. Review the spelling before approval.',
  CANDIDATE_MEDIUM: 'One tariff code, but too few kelurahan+postal codes matched to be sure. Needs extra evidence before approval.',
};

/** Manifest rows (import-jne-mapping-manifest.ts format) for one candidate tier. */
export function manifestRows(results: DistrictResult[], klass: DistrictClass, source: { dataset: string; version: string }) {
  // Only the candidate tiers. An exception class (AMBIGUOUS, CODE_NOT_IN_MASTER, ...)
  // must never be turned into a proposable row, whatever code it happens to carry.
  if (!TIER_CONFIDENCE[klass]) return [];
  return results
    .filter((r) => r.klass === klass && r.candidateCode)
    .map((r) => ({
      district_code: r.district.code,
      jne_code: r.candidateCode as string,
      confidence: TIER_CONFIDENCE[klass],
      source_dataset: source.dataset,
      source_version: source.version,
      evidence: r.evidence,
      rationale: TIER_RATIONALE[klass],
    }));
}

/** Counts per class, overall and for each province, with resolvable/projected figures. */
export function summarize(out: ReconcileOutput) {
  const count = (rs: DistrictResult[]) => {
    const byClass: Record<string, number> = {};
    for (const r of rs) byClass[r.klass] = (byClass[r.klass] ?? 0) + 1;
    const resolvableNow = rs.filter((r) => r.klass.startsWith('MAPPED_')).length;
    const strong = byClass.CANDIDATE_STRONG ?? 0;
    const high = byClass.CANDIDATE_HIGH ?? 0;
    return {
      districts: rs.length,
      byClass,
      resolvableNow,
      // Projections assume every candidate in the tier is reviewed AND approved - they
      // are not runtime coverage until that has actually happened.
      projectedIfStrongApproved: resolvableNow + strong,
      projectedIfStrongAndHighApproved: resolvableNow + strong + high,
    };
  };
  const byProvince: Record<string, ReturnType<typeof count>> = {};
  for (const p of [...new Set(out.results.map((r) => r.district.province))].sort()) {
    byProvince[p] = count(out.results.filter((r) => r.district.province === p));
  }
  const byCity: Record<string, ReturnType<typeof count>> = {};
  for (const c of [...new Set(out.results.map((r) => `${r.district.province} / ${r.district.city}`))].sort()) {
    byCity[c] = count(out.results.filter((r) => `${r.district.province} / ${r.district.city}` === c));
  }
  return {
    nationwide: count(out.results),
    sheetCodes: out.sheetCodes,
    sheetCodesNotInMaster: out.sheetCodesNotInMaster.length,
    sheetCodesOnlyAsOrigin: out.sheetCodesNotInMaster.filter((c) => c.originOnly).length,
    masterDestinationsNotInSheet: out.masterDestinationsNotInSheet,
    ambiguousCityNames: out.ambiguousCityNames.length,
    unrecognizedProvinceRows: out.unrecognizedProvinces.reduce((n, p) => n + p.rows, 0),
    unrecognizedProvinces: out.unrecognizedProvinces,
    byProvince,
    byCity,
  };
}

// ------------------------------------------------------------------ file input

const bool = (v: string) => v === 't' || v === 'true';

export function loadInput(files: { sheet: string; districts: string; villages: string; locations: string; mappings: string }): ReconcileInput {
  const rec = (file: string, cols: readonly string[]) => parseCsvRecords(readFileSync(file, 'utf8'), cols).records.map((r) => r.values);
  return {
    sheet: rec(files.sheet, SHEET_COLUMNS).map((v) => ({
      province: v.PROVINCE_NAME.trim(),
      city: v.CITY_NAME.trim(),
      district: v.DISTRICT_NAME.trim(),
      subdistrict: v.SUBDISTRICT_NAME.trim(),
      zip: v.ZIP_CODE.trim(),
      code: v.TARIFF_CODE.trim().toUpperCase(),
    })),
    districts: rec(files.districts, ['district_code', 'district', 'd_active', 'city', 'city_type', 'c_active', 'province']).map((v) => ({
      code: v.district_code,
      name: v.district,
      active: bool(v.d_active) && bool(v.c_active),
      cityCode: v.city_code ?? '',
      city: v.city,
      cityType: v.city_type,
      province: v.province,
    })),
    villages: rec(files.villages, ['village_code', 'district_code', 'village', 'postal_code', 'v_active']).map((v) => ({
      code: v.village_code,
      districtCode: v.district_code,
      name: v.village,
      postalCode: v.postal_code,
      active: bool(v.v_active),
    })),
    locations: rec(files.locations, ['code', 'kind', 'source', 'active', 'raw_name', 'parsed_child']).map((v) => ({
      code: v.code,
      kind: v.kind,
      source: v.source,
      active: bool(v.active),
      rawName: v.raw_name,
      parsedChild: v.parsed_child,
    })),
    mappings: rec(files.mappings, ['district_code', 'jne_code', 'kind', 'loc_active', 'status', 'm_active']).map((v) => ({
      districtCode: v.district_code,
      jneCode: v.jne_code,
      kind: v.kind,
      locationActive: bool(v.loc_active),
      status: v.status,
      active: bool(v.m_active),
    })),
  };
}

const RESULT_COLUMNS = ['district_code', 'district', 'city', 'city_type', 'province', 'class', 'candidate_code', 'mapping', 'evidence'] as const;
const resultRow = (r: DistrictResult) => ({
  district_code: r.district.code,
  district: r.district.name,
  city: r.district.city,
  city_type: r.district.cityType,
  province: r.district.province,
  class: r.klass,
  candidate_code: r.candidateCode ?? '',
  mapping: r.mapping,
  evidence: r.evidence,
});
export const EXCEPTION_CLASSES: readonly DistrictClass[] = ['AMBIGUOUS', 'CODE_NOT_IN_MASTER', 'NO_EVIDENCE', 'EXISTING_NOT_USABLE', 'MAPPED_MISMATCH', 'MAPPED_UNVERIFIED', 'MAPPED_AMBIGUOUS_EVIDENCE'];

if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const files = { sheet: get('--sheet'), districts: get('--districts'), villages: get('--villages'), locations: get('--locations'), mappings: get('--mappings') };
  const outDir = get('--out');
  if (Object.values(files).some((f) => !f) || !outDir) {
    console.error('usage: --sheet --districts --villages --locations --mappings <csv> --out <dir> [--source-dataset <name>]');
    process.exit(2);
  }
  const sheetText = readFileSync(files.sheet as string);
  const source = {
    dataset: get('--source-dataset') ?? 'JNE list_dest',
    // The list's provenance and date are unknown; a content hash is the version. Pass
    // --source-version to name the ORIGINAL file (e.g. the .xlsx this CSV came from).
    version: get('--source-version') ?? `sha256:${createHash('sha256').update(sheetText).digest('hex').slice(0, 16)}`,
  };
  const out = reconcileDestinations(loadInput(files as Record<keyof typeof files, string>));
  mkdirSync(outDir, { recursive: true });
  const manifestCols = ['district_code', 'jne_code', 'confidence', 'source_dataset', 'source_version', 'evidence', 'rationale'];
  writeFileSync(join(outDir, 'manifest-strong.csv'), toCsv(manifestCols, manifestRows(out.results, 'CANDIDATE_STRONG', source)));
  writeFileSync(join(outDir, 'manifest-high.csv'), toCsv(manifestCols, manifestRows(out.results, 'CANDIDATE_HIGH', source)));
  writeFileSync(join(outDir, 'manifest-medium.csv'), toCsv(manifestCols, manifestRows(out.results, 'CANDIDATE_MEDIUM', source)));
  writeFileSync(join(outDir, 'exceptions.csv'), toCsv(RESULT_COLUMNS, out.results.filter((r) => EXCEPTION_CLASSES.includes(r.klass)).map(resultRow)));
  writeFileSync(join(outDir, 'districts.csv'), toCsv(RESULT_COLUMNS, out.results.map(resultRow)));
  writeFileSync(join(outDir, 'sheet-codes-not-in-master.csv'), toCsv(['code', 'rows', 'originOnly'], out.sheetCodesNotInMaster));
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ source, ...summarize(out), ambiguousCityNames: out.ambiguousCityNames }, null, 2));
  console.log(JSON.stringify({ source, ...summarize(out).nationwide }, null, 2));
}
