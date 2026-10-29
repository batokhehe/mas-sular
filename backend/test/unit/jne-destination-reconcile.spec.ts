/**
 * Offline reconciliation of a JNE destination list against our region master and
 * the JNE master. Synthetic fixture, one district per classification. The rules
 * pinned: kelurahan+postal code is the only evidence, several codes are never
 * resolved by picking one, a code missing from the master is never invented, and
 * a REGENCY is proposed only through that evidence - never by name.
 */
import {
  manifestRows,
  reconcileDestinations,
  sameProvince,
  summarize,
  type ReconcileInput,
  type SheetRow,
} from '../../prisma/tools/reconcile-jne-destinations';

const sheet = (district: string, subdistrict: string, zip: string, code: string, over: Partial<SheetRow> = {}): SheetRow => ({
  province: 'JAWA BARAT',
  city: 'BANDUNG',
  district,
  subdistrict,
  zip,
  code,
  ...over,
});
const dist = (code: string, name: string, city = 'Kabupaten Bandung', cityType = 'REGENCY', active = true) => ({
  code,
  name,
  active,
  cityCode: code.slice(0, 5),
  city,
  cityType,
  province: 'Jawa Barat',
});
const vil = (districtCode: string, n: number, name: string, postalCode: string) => ({ code: `${districtCode}.${2000 + n}`, districtCode, name, postalCode, active: true });
const loc = (code: string, rawName: string, kind = 'DESTINATION', active = true) => ({ code, kind, source: 'SANDBOX', active, rawName, parsedChild: rawName.split(',')[0] });

const input: ReconcileInput = {
  districts: [
    dist('32.04.08', 'Bojongsoang'), // strong
    dist('32.04.06', 'Cimenyan'), // high: list spells it differently
    dist('32.04.34', 'Solokanjeruk'), // medium: one of several villages matches
    dist('32.77.02', 'Cimahi Tengah', 'Kota Cimahi', 'CITY'), // ambiguous: two codes
    dist('32.04.46', 'Kutawaringin'), // code missing from master
    dist('32.04.40', 'Rancabali'), // no evidence: postal codes differ
    dist('32.73.01', 'Sukasari', 'Kota Bandung', 'CITY'), // already mapped
    dist('32.73.20', 'Antapani', 'Kota Bandung', 'CITY'), // pending candidate only
    dist('32.04.99', 'Retired', 'Kabupaten Bandung', 'REGENCY', false), // inactive: skipped
  ],
  villages: [
    vil('32.04.08', 1, 'Bojongsoang', '40288'),
    vil('32.04.08', 2, 'Bojongsari', '40288'),
    vil('32.04.08', 3, 'Lengkong', '40287'),
    vil('32.04.06', 1, 'Mekarsaluyu', '40191'),
    vil('32.04.06', 2, 'Cimenyan', '40191'),
    vil('32.04.34', 1, 'Solokanjeruk', '40375'),
    vil('32.04.34', 2, 'Cibodas', '40376'),
    vil('32.04.34', 3, 'Langensari', '40376'),
    vil('32.77.02', 1, 'Cigugur Tengah', '40522'),
    vil('32.77.02', 2, 'Karangmekar', '40523'),
    vil('32.04.46', 1, 'Kutawaringin', '40911'),
    vil('32.04.46', 2, 'Jatisari', '40911'),
    vil('32.04.40', 1, 'Alamendah', '40974'),
    vil('32.73.01', 1, 'Gegerkalong', '40153'),
    vil('32.73.01', 2, 'Isola', '40154'),
    vil('32.73.20', 1, 'Antapani Kidul', '40291'),
  ],
  sheet: [
    sheet('BOJONGSOANG', 'BOJONG SOANG', '40288', 'BDO10104'),
    sheet('BOJONGSOANG', 'BOJONGSARI', '40288', 'BDO10104'),
    sheet('BOJONGSOANG', 'LENGKONG', '40287', 'BDO10104'),
    // Kota Bandung also has a LENGKONG; another postal code keeps it apart.
    sheet('LENGKONG', 'LENGKONG', '40261', 'BDO10040'),
    sheet('CIMEUNYAN', 'MEKARSALUYU', '40191', 'BDO10111'),
    sheet('CIMEUNYAN', 'CIMENYAN', '40191', 'BDO10111'),
    sheet('SOLOKANJERUK', 'SOLOKANJERUK', '40375', 'BDO10130'),
    sheet('SOLOKAN JERUK', 'CIBODAS', '40999', 'BDO10130'),
    sheet('CIMAHI TENGAH', 'CIGUGUR TENGAH', '40522', 'BDO20118', { city: 'CIMAHI' }),
    sheet('CIMAHI TENGAH', 'KARANGMEKAR', '40523', 'BDO20100', { city: 'CIMAHI' }),
    sheet('KUTAWARINGIN', 'KUTAWARINGIN', '40911', 'BDO10131'),
    sheet('KUTAWARINGIN', 'JATISARI', '40911', 'BDO10131'),
    sheet('RANCABALI', 'ALAMENDAH', '40973', 'BDO10128'),
    sheet('SUKASARI', 'GEGERKALONG', '40153', 'BDO10037'),
    sheet('SUKASARI', 'ISOLA', '40154', 'BDO10037'),
    sheet('ANTAPANI', 'ANTAPANI KIDUL', '40291', 'BDO10038'),
    // Same kelurahan name and postal code in another province: never evidence here.
    sheet('BOJONGSOANG', 'BOJONGSOANG', '40288', 'XXX99999', { province: 'JAWA TENGAH' }),
    // A province label that matches none of ours.
    sheet('X', 'X', '12345', 'BDO10104', { province: 'KEPI' }),
  ],
  locations: [
    loc('BDO10104', 'BOJONG SOANG,SOREANG'),
    loc('BDO10111', 'CIMENYAN,SOREANG'),
    loc('BDO10130', 'SOLOKAN JERUK,SOREANG'),
    loc('BDO20118', 'CIMAHI TENGAH,CIMAHI'),
    loc('BDO20100', 'CIMAHI'),
    loc('BDO10128', 'RANCABALI,SOREANG'),
    loc('BDO10037', 'SUKASARI,BANDUNG'),
    loc('BDO10038', 'ANTAPANI,BANDUNG'),
    loc('BDO10040', 'LENGKONG,BANDUNG'),
    // A name with an embedded newline, as JNE's master really has.
    loc('BTH10317', 'SERASAN\nTIMUR,NATUNA'),
    loc('BDO10131', 'KUTAWARINGIN,SOREANG', 'ORIGIN'),
  ],
  mappings: [
    { districtCode: '32.73.01', jneCode: 'BDO10037', kind: 'DESTINATION', locationActive: true, status: 'MATCHED', active: true },
    { districtCode: '32.73.20', jneCode: 'BDO10038', kind: 'DESTINATION', locationActive: true, status: 'REVIEW_REQUIRED', active: true },
  ],
};

const out = reconcileDestinations(input);
const klass = (code: string) => out.results.find((r) => r.district.code === code)?.klass;
const result = (code: string) => out.results.find((r) => r.district.code === code)!;

describe('reconcileDestinations', () => {
  it('classifies each district by kelurahan+postal evidence', () => {
    expect(Object.fromEntries(out.results.map((r) => [r.district.code, r.klass]))).toEqual({
      '32.04.06': 'CANDIDATE_HIGH',
      '32.04.08': 'CANDIDATE_STRONG',
      '32.04.34': 'CANDIDATE_MEDIUM',
      '32.04.40': 'NO_EVIDENCE',
      '32.04.46': 'CODE_NOT_IN_MASTER',
      '32.73.01': 'MAPPED_VERIFIED',
      '32.73.20': 'EXISTING_NOT_USABLE',
      '32.77.02': 'AMBIGUOUS',
    });
  });

  it('Bojongsoang: one code for all three villages; another province never counts', () => {
    expect(result('32.04.08')).toMatchObject({ candidateCode: 'BDO10104', villagesMatched: 3, codeVotes: [['BDO10104', 3]], districtNameAgrees: [3, 3] });
  });

  it('never picks one of several plausible codes', () => {
    expect(result('32.77.02')).toMatchObject({ klass: 'AMBIGUOUS', candidateCode: null });
    expect(result('32.77.02').codeVotes).toEqual([
      ['BDO20100', 1],
      ['BDO20118', 1],
    ]);
  });

  it('never invents a missing master code, even when the code exists as an ORIGIN', () => {
    expect(klass('32.04.46')).toBe('CODE_NOT_IN_MASTER');
    expect(out.sheetCodesNotInMaster).toContainEqual({ code: 'BDO10131', rows: 2, originOnly: true });
  });

  it('a district or city name alone is not evidence', () => {
    // Rancabali's name is in the list, but no kelurahan+postal code matches.
    expect(result('32.04.40')).toMatchObject({ klass: 'NO_EVIDENCE', candidateCode: null, villagesMatched: 0 });
  });

  it('a REGENCY is proposed only through village evidence (the automatic name rule still refuses it)', () => {
    expect(result('32.04.08').district.cityType).toBe('REGENCY');
    expect(klass('32.04.08')).toBe('CANDIDATE_STRONG');
    expect(klass('32.04.40')).toBe('NO_EVIDENCE');
  });

  it('keeps an embedded newline from corrupting later records', () => {
    expect(out.results.every((r) => !r.evidence.includes('\n'))).toBe(true);
  });

  it('reports a list city name that lands in more than one internal city', () => {
    expect(out.ambiguousCityNames).toContainEqual({ sheetCity: 'JAWA BARAT/BANDUNG', internalCities: ['Kabupaten Bandung [REGENCY]', 'Kota Bandung [CITY]'] });
  });

  it('reports list rows whose province label matches none of ours instead of guessing', () => {
    expect(out.unrecognizedProvinces).toEqual([
      { province: 'JAWA TENGAH', rows: 1 },
      { province: 'KEPI', rows: 1 },
    ]);
  });

  it('skips inactive districts', () => {
    expect(klass('32.04.99')).toBeUndefined();
  });
});

describe('manifest output', () => {
  const source = { dataset: 'JNE list_dest', version: 'sha256:test' };

  it('only candidate tiers become manifest rows, each with provenance; exceptions never do', () => {
    expect(manifestRows(out.results, 'CANDIDATE_STRONG', source)).toEqual([
      expect.objectContaining({ district_code: '32.04.08', jne_code: 'BDO10104', confidence: 'STRONG', source_dataset: 'JNE list_dest', source_version: 'sha256:test' }),
    ]);
    expect(manifestRows(out.results, 'CANDIDATE_HIGH', source).map((r) => r.district_code)).toEqual(['32.04.06']);
    expect(manifestRows(out.results, 'CANDIDATE_MEDIUM', source).map((r) => r.district_code)).toEqual(['32.04.34']);
    expect(manifestRows(out.results, 'AMBIGUOUS', source)).toEqual([]);
    expect(manifestRows(out.results, 'CODE_NOT_IN_MASTER', source)).toEqual([]);
  });

  it('projections are labelled as projections, separate from what resolves now', () => {
    expect(summarize(out).nationwide).toMatchObject({ districts: 8, resolvableNow: 1, projectedIfStrongApproved: 2, projectedIfStrongAndHighApproved: 3 });
  });
});

describe('sameProvince', () => {
  it.each([
    ['NANGGROE ACEH DARUSSALAM (NAD)', 'Aceh', true],
    ['DKI JAKARTA', 'DKI Jakarta', true],
    ['JAWA BARAT', 'Jawa Barat', true],
    ['JAWA TENGAH', 'Jawa Barat', false],
    ['DI YOGYAKARTA', 'Daerah Istimewa Yogyakarta', true],
    ['DKI JAKARTA', 'Daerah Khusus Ibukota Jakarta', true],
    ['NUSA TENGGARA BARAT', 'Nusa Tenggara Barat', true],
    ['NUSA TENGGARA BARAT (NTB)', 'Nusa Tenggara Barat', true],
    // The list predates the 2022 Papua provinces: the old label admits the new ones...
    ['PAPUA', 'Papua Tengah', true],
    ['PAPUA BARAT', 'Papua Barat Daya', true],
    // ...but never a sibling. Shared words, prefixes and substrings are not a province.
    ['PAPUA', 'Papua Barat', false],
    ['PAPUA BARAT', 'Papua', false],
    ['RIAU', 'Kepulauan Riau', false],
    ['KEPULAUAN RIAU', 'Riau', false],
    ['MALUKU', 'Maluku Utara', false],
    ['MALUKU UTARA', 'Maluku', false],
    ['NUSA TENGGARA BARAT (NTB)', 'Sulawesi Tenggara', false],
    ['SULAWESI TENGGARA', 'Nusa Tenggara Timur', false],
    ['JAWA BARAT', 'Kalimantan Barat', false],
    ['SULAWESI SELATAN', 'Sumatera Selatan', false],
    ['', 'Aceh', false],
  ])('%s vs %s', (a, b, expected) => {
    expect(sameProvince(a, b)).toBe(expected);
  });
});
