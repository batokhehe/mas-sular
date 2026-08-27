import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PHYSICAL_LIMITS,
  toPhysicalFormState,
  toPhysicalPayload,
  validatePhysicalField,
  validatePhysicalState,
} from './physical-attributes.ts';

test('a product with NULL measurements renders EMPTY fields, never 0', () => {
  const state = toPhysicalFormState({
    weightGram: null,
    lengthCm: null,
    widthCm: null,
    heightCm: null,
    isFragile: null,
  });
  assert.equal(state.weightGram, '');
  assert.equal(state.lengthCm, '');
  assert.equal(state.widthCm, '');
  assert.equal(state.heightCm, '');
  assert.equal(state.isFragile, false);
});

test('an undefined product (create form) renders empty fields', () => {
  const state = toPhysicalFormState(undefined);
  assert.deepEqual(state, {
    weightGram: '',
    lengthCm: '',
    widthCm: '',
    heightCm: '',
    isFragile: false,
  });
});

test('an existing measured product renders its real values', () => {
  const state = toPhysicalFormState({
    weightGram: 500,
    lengthCm: 20,
    widthCm: 15,
    heightCm: 10,
    isFragile: true,
  });
  assert.deepEqual(state, {
    weightGram: '500',
    lengthCm: '20',
    widthCm: '15',
    heightCm: '10',
    isFragile: true,
  });
});

test('the required worked example is accepted and sent as integers', () => {
  const state = {
    weightGram: '500',
    lengthCm: '20',
    widthCm: '15',
    heightCm: '10',
    isFragile: false,
  };
  assert.deepEqual(validatePhysicalState(state), []);
  assert.deepEqual(toPhysicalPayload(state), {
    weightGram: 500,
    lengthCm: 20,
    widthCm: 15,
    heightCm: 10,
    isFragile: false,
  });
});

test('payload values are numbers, not strings (backend expects number)', () => {
  const payload = toPhysicalPayload({
    weightGram: '500',
    lengthCm: '20',
    widthCm: '15',
    heightCm: '10',
    isFragile: false,
  });
  for (const key of ['weightGram', 'lengthCm', 'widthCm', 'heightCm'] as const) {
    assert.equal(typeof payload[key], 'number', `${key} must be a number`);
  }
  assert.equal(typeof payload.isFragile, 'boolean');
});

test('weight out of range is rejected at both ends', () => {
  assert.match(validatePhysicalField('weightGram', '0') ?? '', /between 1 and 5000 gram/);
  assert.match(validatePhysicalField('weightGram', '5001') ?? '', /between 1 and 5000 gram/);
  assert.equal(validatePhysicalField('weightGram', '1'), null);
  assert.equal(validatePhysicalField('weightGram', '5000'), null);
});

test('decimal weight is rejected, never silently rounded', () => {
  assert.match(validatePhysicalField('weightGram', '500.5') ?? '', /whole number of gram/);
  // and the value is not coerced behind the scenes
  assert.equal(toPhysicalPayload({
    weightGram: '500.5', lengthCm: '', widthCm: '', heightCm: '', isFragile: false,
  }).weightGram, 500.5, 'parser must not round - validation is what refuses it');
});

test('dimensions out of range are rejected at both ends', () => {
  for (const field of ['lengthCm', 'widthCm', 'heightCm'] as const) {
    assert.match(validatePhysicalField(field, '0') ?? '', /between 1 and 50 cm/);
    assert.match(validatePhysicalField(field, '51') ?? '', /between 1 and 50 cm/);
    assert.equal(validatePhysicalField(field, '1'), null);
    assert.equal(validatePhysicalField(field, '50'), null);
  }
});

test('decimal dimensions are rejected', () => {
  for (const field of ['lengthCm', 'widthCm', 'heightCm'] as const) {
    assert.match(validatePhysicalField(field, '20.5') ?? '', /whole number of cm/);
  }
});

test('non-numeric input is rejected', () => {
  assert.match(validatePhysicalField('weightGram', 'abc') ?? '', /must be a number/);
});

test('EMPTY is valid - editing an unrelated field must not force a measurement', () => {
  for (const field of ['weightGram', 'lengthCm', 'widthCm', 'heightCm'] as const) {
    assert.equal(validatePhysicalField(field, ''), null);
    assert.equal(validatePhysicalField(field, '   '), null);
  }
});

test('empty fields are OMITTED from the payload, so NULL stays NULL', () => {
  const payload = toPhysicalPayload({
    weightGram: '', lengthCm: '', widthCm: '', heightCm: '', isFragile: false,
  });
  // The critical assertion: absent keys, not zeros and not nulls. JSON.stringify
  // drops undefined, so the PATCH never mentions these columns at all.
  assert.deepEqual(Object.keys(payload), ['isFragile']);
  assert.equal('weightGram' in payload, false);
  assert.equal(JSON.stringify(payload), '{"isFragile":false}');
});

test('a partially measured product sends only what was filled in', () => {
  const payload = toPhysicalPayload({
    weightGram: '500', lengthCm: '', widthCm: '', heightCm: '', isFragile: false,
  });
  assert.deepEqual(payload, { weightGram: 500, isFragile: false });
});

test('every invalid field is reported, not just the first', () => {
  const errors = validatePhysicalState({
    weightGram: '9000', lengthCm: '0', widthCm: '20.5', heightCm: '10', isFragile: false,
  });
  assert.equal(errors.length, 3);
});

test('limits match the backend DTO exactly', () => {
  assert.deepEqual(PHYSICAL_LIMITS.weightGram, { min: 1, max: 5000, unit: 'gram' });
  assert.deepEqual(PHYSICAL_LIMITS.lengthCm, { min: 1, max: 50, unit: 'cm' });
  assert.deepEqual(PHYSICAL_LIMITS.widthCm, { min: 1, max: 50, unit: 'cm' });
  assert.deepEqual(PHYSICAL_LIMITS.heightCm, { min: 1, max: 50, unit: 'cm' });
});

test('no PaxelBox dimension can ever appear here - these are PRODUCT fields', () => {
  // PaxelBox is 12/24/36/59 x 47.5 x 47.5 and belongs to the shipment carton,
  // never to a product. 47.5 is not even an integer, and 59 exceeds the cap.
  assert.notEqual(validatePhysicalField('lengthCm', '59'), null);
  assert.notEqual(validatePhysicalField('widthCm', '47.5'), null);
  assert.notEqual(validatePhysicalField('heightCm', '47.5'), null);
});
