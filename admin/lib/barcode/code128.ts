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
