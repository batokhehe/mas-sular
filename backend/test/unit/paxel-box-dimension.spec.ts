import { paxelBoxRateDimension } from '../../src/modules/shipping/infrastructure/providers/paxel-box-dimension';
import { PAXEL_BOX_SIZES, paxelBoxSpec, PaxelBoxSize, SELECTABLE_PAXEL_BOX_SIZES, selectPaxelBox } from '../../src/modules/shipping/domain/paxel-box';
import { isPaxelDimension } from '../../src/modules/shipping/shipping.config';

/**
 * PaxelBoxSize -> Paxel RATE `dimension` string ("LxWxH", whole cm).
 *
 * The box dimensions live only in paxel-box.ts; this mapping reads them and
 * rounds a fractional side (XL's 47.5) for the wire alone. This file pins the
 * mapping, and that the spec itself is never altered by it.
 */

describe('paxelBoxRateDimension — the box → RATE dimension mapping', () => {
  it.each([
    ['S', '20x20x8'],
    ['M', '30x22x12'],
    ['L', '35x30x25'],
    ['XL', '59x48x48'],
  ] as Array<[PaxelBoxSize, string]>)('%s -> %s', (size, expected) => {
    expect(paxelBoxRateDimension(size)).toBe(expected);
  });

  it('produces a string for every declared box size, in one pass', () => {
    const all = PAXEL_BOX_SIZES.map((size) => paxelBoxRateDimension(size));
    expect(all).toEqual(['20x20x8', '30x22x12', '35x30x25', '59x48x48']);
  });

  it('XL is sendable even though 59 exceeds the generic city-rate 1-50 example range', () => {
    // No length cap either: "59x48x48" is 8 characters, well inside Paxel's
    // documented max:11 for /rates/city and /rates/instant.
    const xl = paxelBoxRateDimension('XL');
    expect(xl.length).toBeLessThanOrEqual(11);
    expect(xl).toBe('59x48x48');
  });

  it('is the spec in length x width x height order; S/M/L pass through exactly, unrounded', () => {
    for (const size of SELECTABLE_PAXEL_BOX_SIZES) {
      const spec = paxelBoxSpec(size);
      expect(paxelBoxRateDimension(size)).toBe(`${spec.lengthCm}x${spec.widthCm}x${spec.heightCm}`);
    }
  });

  it('every selectable box is within the 1-50 cm LxWxH range the project validates Paxel dimensions with', () => {
    for (const size of SELECTABLE_PAXEL_BOX_SIZES) expect(isPaxelDimension(paxelBoxRateDimension(size))).toBe(true);
  });

  it('a fractional side (XL 47.5) is rounded ONLY in this mapping — the spec keeps 47.5', () => {
    const spec = paxelBoxSpec('XL');
    expect([spec.widthCm, spec.heightCm]).toEqual([47.5, 47.5]);
    expect(paxelBoxRateDimension('XL')).toBe('59x48x48');
  });

  it('does not duplicate the box thresholds — it composes selectPaxelBox() + paxelBoxSpec(), not its own table', () => {
    // If this file re-implemented "1-3 -> S" etc., changing PAXELBOX-1's
    // threshold would silently desync the two. Proven here by driving the
    // dimension purely through the reused selector for every boundary.
    const cases: Array<[number, string]> = [
      [1, '20x20x8'], [3, '20x20x8'],
      [4, '30x22x12'], [10, '30x22x12'],
      [11, '35x30x25'], [20, '35x30x25'],
    ];
    for (const [quantity, expected] of cases) {
      const box = selectPaxelBox(quantity);
      // Narrowing, not an assertion: a selectable quantity always has a box.
      if (box === null) throw new Error(`expected a box for quantity ${quantity}`);
      expect(paxelBoxRateDimension(box)).toBe(expected);
    }
  });

  // PAXELBOX-17: this used to assert 21 -> '59x48x48'. That encoded the very
  // defect the audit found — XL is out of scope, so >20 has no box and there is
  // no dimension to build. The XL dimension itself is still exercised above as
  // reference data; what changed is that selection can no longer reach it.
  it('builds no dimension past L, because >20 has no supported box', () => {
    for (const quantity of [21, 22, 50, 100]) {
      expect(selectPaxelBox(quantity)).toBeNull();
    }
  });
});
