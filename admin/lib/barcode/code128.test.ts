import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODE128_PATTERNS,
  code128Bars,
  code128BChecksum,
  decodeCode128B,
  encodeCode128B,
  isCode128BEncodable,
  START_B,
  STOP,
} from './code128.ts';

/**
 * P3 — in-house Code 128 (set B). Verified against the published symbol bit
 * patterns, the classic "Wikipedia" checksum example, the table's structural
 * invariants and a decode round-trip. Scannability is confirmed manually.
 */

const bits = (pattern: string) => [...pattern].map((w, i) => (i % 2 === 0 ? '1' : '0').repeat(Number(w))).join('');

test('symbol table integrity: 107 unique patterns, 11 modules each (STOP 13), even bar modules', () => {
  assert.equal(CODE128_PATTERNS.length, 107);
  assert.equal(new Set(CODE128_PATTERNS).size, 107);
  CODE128_PATTERNS.forEach((pattern, value) => {
    const widths = [...pattern].map(Number);
    const total = widths.reduce((a, b) => a + b, 0);
    assert.equal(total, value === STOP ? 13 : 11, `value ${value}`);
    if (value !== STOP) {
      assert.equal(widths.length, 6);
      const bars = widths[0] + widths[2] + widths[4];
      assert.equal(bars % 2, 0, `value ${value}: bar modules must be even`);
      assert.ok(widths.every((w) => w >= 1 && w <= 4), `value ${value}: widths 1..4`);
    }
  });
});

test('known bit patterns: START B, STOP, "A" and space', () => {
  assert.equal(bits(CODE128_PATTERNS[START_B]), '11010010000');
  assert.equal(bits(CODE128_PATTERNS[STOP]), '1100011101011');
  assert.equal(bits(CODE128_PATTERNS['A'.charCodeAt(0) - 32]), '10100011000');
  assert.equal(bits(CODE128_PATTERNS[0]), '11011001100'); // space
});

test('checksum: the classic "Wikipedia" example is 88; position weights start at 1', () => {
  assert.equal(code128BChecksum('Wikipedia'), 88);
  const enc = encodeCode128B('Wikipedia');
  assert.ok(enc);
  assert.equal(enc.checksum, 88);
  assert.deepEqual(enc.symbols, [104, 55, 73, 75, 73, 80, 69, 68, 73, 65, 88, 106]);
  // "AB": (104 + 1*33 + 2*34) % 103 = 102
  assert.equal(code128BChecksum('AB'), 102);
});

test('structure: START B + data + checksum + STOP, exact module count, deterministic', () => {
  const single = encodeCode128B('A');
  assert.ok(single);
  assert.equal(
    single.modules,
    `${bits(CODE128_PATTERNS[104])}${bits(CODE128_PATTERNS[33])}${bits(CODE128_PATTERNS[(104 + 33) % 103])}${bits(CODE128_PATTERNS[106])}`,
  );
  for (const value of ['A', '0109401600067399', 'PXL-2026091712345678ABCDEFGH']) {
    const e = encodeCode128B(value);
    assert.ok(e);
    assert.equal(e.modules.length, 11 * (value.length + 2) + 13);
    assert.ok(e.modules.startsWith('11010010000') && e.modules.endsWith('1100011101011'));
    assert.deepEqual(encodeCode128B(value), e, 'deterministic');
  }
});

test('numeric JNE-like and alphanumeric Paxel-like AWBs round-trip EXACTLY (punctuation and case kept)', () => {
  const printable = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('');
  for (const awb of ['0109401600067399', 'JNE0109401600067399', 'PXL-2026091712345678ABCDEFGH', 'AWB/12-34 x.y_z', printable]) {
    const enc = encodeCode128B(awb);
    assert.ok(enc, awb);
    assert.equal(decodeCode128B(enc.modules), awb);
  }
});

test('invalid input is refused: empty, non-ASCII, control characters, non-strings', () => {
  const bad = [
    '',
    `JNE${String.fromCharCode(10)}123`, // newline
    `AWB${String.fromCharCode(9)}1`, // tab
    `AWB${String.fromCharCode(127)}`, // DEL
    `${String.fromCharCode(0xc5)}WB123`, // non-ASCII letter
    `AWB${String.fromCharCode(0x20ac)}`, // euro sign
  ];
  for (const value of bad) {
    assert.equal(isCode128BEncodable(value), false, JSON.stringify(value));
    assert.equal(encodeCode128B(value), null);
  }
  assert.equal(encodeCode128B(null), null);
  assert.equal(encodeCode128B(123 as unknown), null);
});

test('decoder rejects a corrupted checksum or symbol', () => {
  const enc = encodeCode128B('AWB123');
  assert.ok(enc);
  const corrupt = enc.modules.slice(0, 11) + bits(CODE128_PATTERNS[34]) + enc.modules.slice(22);
  assert.equal(decodeCode128B(corrupt), null);
  assert.equal(decodeCode128B('101'), null);
});

test('bars: runs of 1s offset by the quiet zone', () => {
  assert.deepEqual(code128Bars('1101', 10), [[10, 2], [13, 1]]);
  assert.deepEqual(code128Bars('0110', 0), [[1, 2]]);
});
