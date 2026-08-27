import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatNumberID, formatRupiah, formatRupiahExact } from './number.ts';

test('IDR formatting: thousand separators, Rp prefix', () => {
  assert.equal(formatNumberID(1234567), '1.234.567');
  assert.equal(formatRupiah(250000), 'Rp 250.000');
  assert.equal(formatRupiahExact(250000), 'Rp 250.000');
});

test('zero and negative values', () => {
  assert.equal(formatNumberID(0), '0');
  assert.equal(formatRupiah(0), 'Rp 0');
  assert.equal(formatRupiah(-15000), 'Rp -15.000');
  assert.equal(formatNumberID(-1234), '-1.234');
});

test('large values keep full precision', () => {
  assert.equal(formatNumberID(9007199254740991), '9.007.199.254.740.991');
  assert.equal(formatRupiahExact(1_000_000_000), 'Rp 1.000.000.000');
});

test('decimal handling: formatRupiah rounds, formatRupiahExact does not', () => {
  assert.equal(formatRupiah(12345.6), 'Rp 12.346'); // Math.round — same as legacy helpers
  assert.equal(formatRupiah(12345.4), 'Rp 12.345');
  assert.equal(formatRupiahExact(12345.6), 'Rp 12.345,6'); // passthrough, id-ID decimal comma
});

test('invalid input (NaN) renders as NaN — matches legacy toLocaleString behavior', () => {
  assert.equal(formatNumberID(Number.NaN), 'NaN');
  assert.equal(formatRupiah(Number.NaN), 'Rp NaN');
});
