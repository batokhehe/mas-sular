/**
 * Code 128 (code set B) encoder — pure TypeScript, no dependency (P3 packing slip).
 *
 * Code set B covers every printable ASCII character (space 0x20 .. tilde 0x7E), so
 * any real AWB - digits (JNE), letters, dashes, slashes (Paxel) - is encoded
 * exactly as stored, character for character. Anything else (empty, control
 * characters, non-ASCII) is refused: the caller renders no barcode rather than a
 * barcode of a different value.
 *
 * Symbol = quiet zone | START B | data | checksum | STOP | quiet zone. Each symbol is
 * 3 bars + 3 spaces spanning 11 modules; STOP has a 4th bar (13 modules).
 * checksum = (104 + sum(position_i * value_i)) mod 103, positions starting at 1.
 */

/** Bar/space widths for symbol values 0..106 (ISO/IEC 15417). */
export const CODE128_PATTERNS: readonly string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

export const START_B = 104;
export const STOP = 106;
/** Minimum quiet zone on each side, in modules. */
export const QUIET_ZONE_MODULES = 10;

const FIRST_B = 0x20;
const LAST_B = 0x7e;

/** True when every character is printable ASCII (code set B) and the value is non-empty. */
export function isCode128BEncodable(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < FIRST_B || code > LAST_B) return false;
  }
  return true;
}

export interface Code128Encoding {
  /** Symbol values: START B, data..., checksum, STOP. */
  symbols: number[];
  checksum: number;
  /** Module string for the whole symbol (no quiet zone): '1' = bar, '0' = space. */
  modules: string;
}

export function code128BChecksum(value: string): number {
  let sum = START_B;
  for (let i = 0; i < value.length; i += 1) sum += (i + 1) * (value.charCodeAt(i) - FIRST_B);
  return sum % 103;
}

function patternModules(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) out += (i % 2 === 0 ? '1' : '0').repeat(Number(pattern[i]));
  return out;
}

/** Encode `value` in code set B, or null when it cannot be encoded exactly. */
export function encodeCode128B(value: unknown): Code128Encoding | null {
  if (!isCode128BEncodable(value)) return null;
  const data = Array.from(value, (char) => char.charCodeAt(0) - FIRST_B);
  const checksum = code128BChecksum(value);
  const symbols = [START_B, ...data, checksum, STOP];
  return { symbols, checksum, modules: symbols.map((symbol) => patternModules(CODE128_PATTERNS[symbol])).join('') };
}

/** Bars as [startModule, widthInModules] runs, offset by the quiet zone - what the SVG draws. */
export function code128Bars(modules: string, quietZone = QUIET_ZONE_MODULES): Array<[number, number]> {
  const bars: Array<[number, number]> = [];
  let i = 0;
  while (i < modules.length) {
    if (modules[i] === '1') {
      let j = i;
      while (j < modules.length && modules[j] === '1') j += 1;
      bars.push([i + quietZone, j - i]);
      i = j;
    } else {
      i += 1;
    }
  }
  return bars;
}

/**
 * Decode a code set B module string back to text (verifies start, every symbol,
 * checksum and stop). Used to prove the barcode carries exactly the input value.
 */
export function decodeCode128B(modules: string): string | null {
  const byPattern = new Map(CODE128_PATTERNS.slice(0, 106).map((p, value) => [patternModules(p), value]));
  const stop = patternModules(CODE128_PATTERNS[STOP]);
  if (!modules.endsWith(stop) || (modules.length - stop.length) % 11 !== 0) return null;
  const symbols: number[] = [];
  for (let i = 0; i < modules.length - stop.length; i += 11) {
    const value = byPattern.get(modules.slice(i, i + 11));
    if (value === undefined) return null;
    symbols.push(value);
  }
  if (symbols.length < 3 || symbols[0] !== START_B) return null;
  const data = symbols.slice(1, -1);
  const text = String.fromCharCode(...data.map((v) => v + FIRST_B));
  return code128BChecksum(text) === symbols[symbols.length - 1] ? text : null;
}

/* ------------------------------------------------------------------------------------
 * Automatic code set selection (B + C) — Print Resi.
 *
 * Code set C packs two digits into one symbol, so a numeric AWB (JNE cnote, e.g.
 * "0291492600000050") is roughly half as wide as in set B and its bars can be printed
 * wider (more scanner-tolerant) on a 100 mm label. Letters, punctuation and short digit
 * runs stay in set B, so every printable-ASCII AWB (Paxel "CO.EMSULAR-20261030-1-CYOCBX")
 * is still encoded EXACTLY. Plain Code 128: no FNC1 (not GS1-128), no set A.
 *
 * Selection follows the ISO/IEC 15417 Annex E minimisation rules restricted to B/C:
 *  - start in C when the data begins with >= 4 digits (or is exactly 2 digits);
 *  - in B, switch to C before a run of >= 4 digits that ends the data, or >= 6 digits
 *    elsewhere; an odd run encodes its first digit in B before switching;
 *  - in C, switch back to B as soon as fewer than 2 digits remain in the run.
 * ---------------------------------------------------------------------------------- */

export const START_C = 105;
/** "Code C" in set B; "Code B" in set C. */
export const SWITCH_TO_C = 99;
export const SWITCH_TO_B = 100;

const isDigit = (code: number) => code >= 0x30 && code <= 0x39;

function digitRun(value: string, from: number): number {
  let i = from;
  while (i < value.length && isDigit(value.charCodeAt(i))) i += 1;
  return i - from;
}

export interface Code128AutoEncoding extends Code128Encoding {
  /** Total width in modules, INCLUDING both quiet zones. */
  totalModules: number;
}

function checksumOf(symbols: number[]): number {
  let sum = symbols[0];
  for (let i = 1; i < symbols.length; i += 1) sum += i * symbols[i];
  return sum % 103;
}

/** Encode `value` with automatic B/C selection, or null when it cannot be encoded exactly. */
export function encodeCode128(value: unknown): Code128AutoEncoding | null {
  if (!isCode128BEncodable(value)) return null;
  const n = value.length;
  const leading = digitRun(value, 0);
  let set: 'B' | 'C' = leading >= 4 || (leading === 2 && n === 2) ? 'C' : 'B';
  const data: number[] = [set === 'C' ? START_C : START_B];
  let i = 0;
  while (i < n) {
    if (set === 'C') {
      if (digitRun(value, i) >= 2) {
        data.push(Number(value.slice(i, i + 2)));
        i += 2;
      } else {
        data.push(SWITCH_TO_B);
        set = 'B';
      }
      continue;
    }
    const run = digitRun(value, i);
    if ((run >= 4 && i + run === n) || run >= 6) {
      if (run % 2 === 1) {
        data.push(value.charCodeAt(i) - FIRST_B);
        i += 1;
      }
      data.push(SWITCH_TO_C);
      set = 'C';
      continue;
    }
    data.push(value.charCodeAt(i) - FIRST_B);
    i += 1;
  }
  const checksum = checksumOf(data);
  const symbols = [...data, checksum, STOP];
  const modules = symbols.map((symbol) => patternModules(CODE128_PATTERNS[symbol])).join('');
  return { symbols, checksum, modules, totalModules: modules.length + QUIET_ZONE_MODULES * 2 };
}

/**
 * Decode ANY plain Code 128 module string that uses sets B and C (start B or C, the
 * B<->C switches) back to text, verifying every symbol, the checksum and STOP. Anything
 * else (set A, shifts, FNC codes, corruption) is refused with null. This is an
 * independent reader used to prove the drawn barcode carries exactly the AWB.
 */
export function decodeCode128(modules: string): string | null {
  const byPattern = new Map(CODE128_PATTERNS.slice(0, 106).map((p, value) => [patternModules(p), value]));
  const stop = patternModules(CODE128_PATTERNS[STOP]);
  if (!modules.endsWith(stop) || (modules.length - stop.length) % 11 !== 0) return null;
  const symbols: number[] = [];
  for (let i = 0; i < modules.length - stop.length; i += 11) {
    const value = byPattern.get(modules.slice(i, i + 11));
    if (value === undefined) return null;
    symbols.push(value);
  }
  if (symbols.length < 3) return null;
  const data = symbols.slice(0, -1);
  if (checksumOf(data) !== symbols[symbols.length - 1]) return null;
  let set: 'B' | 'C';
  if (data[0] === START_B) set = 'B';
  else if (data[0] === START_C) set = 'C';
  else return null;
  let text = '';
  for (const v of data.slice(1)) {
    if (set === 'B') {
      if (v < 95) text += String.fromCharCode(v + FIRST_B);
      else if (v === SWITCH_TO_C) set = 'C';
      else return null;
    } else if (v < 100) text += String(v).padStart(2, '0');
    else if (v === SWITCH_TO_B) set = 'B';
    else return null;
  }
  return text;
}

/** Rebuild the module string from drawn bars (inverse of code128Bars) — for verification. */
export function modulesFromBars(bars: ReadonlyArray<readonly [number, number]>, totalModules: number, quietZone = QUIET_ZONE_MODULES): string {
  const cells = new Array<string>(totalModules).fill('0');
  for (const [x, w] of bars) for (let k = 0; k < w; k += 1) cells[x + k] = '1';
  return cells.join('').slice(quietZone, totalModules - quietZone);
}

/** Printer dot pitch at 203 dpi (8 dots/mm), the common thermal label resolution. */
export const DOT_MM = 0.125;
/** Narrowest bar we snap to: 2 dots @ 203 dpi (0.25 mm). */
export const MIN_SNAPPED_MODULE_MM = 2 * DOT_MM;
/** Widest bar: 4 dots @ 203 dpi (0.5 mm). */
export const MAX_SNAPPED_MODULE_MM = 4 * DOT_MM;

export interface BarcodeSize {
  /** Width of one module (narrowest bar) in mm. */
  moduleMm: number;
  /** Total symbol width including quiet zones, in mm. */
  widthMm: number;
  /** True when the module is a whole number of 203-dpi dots (crisp, uniform bars). */
  snapped: boolean;
  /**
   * True when the narrowest bar is at least MIN_SNAPPED_MODULE_MM (0.25 mm = 2 dots @
   * 203 dpi) - the declared safe minimum for this label. False means the symbol only
   * fits by shrinking below it; callers must surface that, never hide it.
   */
  meetsMinimum: boolean;
}

/**
 * Physical barcode size: the widest whole-dot module (0.5 / 0.375 / 0.25 mm) whose
 * symbol fits `maxWidthMm`. A symbol too long even at 0.25 mm is scaled to fit
 * (snapped=false) instead of overflowing the label.
 */
export function barcodeSize(totalModules: number, maxWidthMm: number): BarcodeSize {
  for (let dots = MAX_SNAPPED_MODULE_MM / DOT_MM; dots * DOT_MM >= MIN_SNAPPED_MODULE_MM; dots -= 1) {
    const moduleMm = dots * DOT_MM;
    if (totalModules * moduleMm <= maxWidthMm) return { moduleMm, widthMm: totalModules * moduleMm, snapped: true, meetsMinimum: true };
  }
  return { moduleMm: maxWidthMm / totalModules, widthMm: maxWidthMm, snapped: false, meetsMinimum: false };
}
