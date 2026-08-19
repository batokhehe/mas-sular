import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trailingDebounce } from './debounce.ts';

test('a burst of calls collapses into ONE trailing invocation (SSE storm → one refetch)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls: string[] = [];
  const debounced = trailingDebounce((v: string) => calls.push(v), 1500);

  debounced('e1');
  debounced('e2');
  t.mock.timers.tick(1000); // still inside the burst window
  debounced('e3');
  assert.equal(calls.length, 0); // nothing fired yet

  t.mock.timers.tick(1500);
  assert.deepEqual(calls, ['e3']); // once, with the LAST args
});

test('separate bursts each fire once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls: number[] = [];
  const debounced = trailingDebounce((v: number) => calls.push(v), 500);

  debounced(1);
  t.mock.timers.tick(500);
  debounced(2);
  t.mock.timers.tick(500);
  assert.deepEqual(calls, [1, 2]);
});

test('cancel() drops the pending invocation (component unmount safety)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls: number[] = [];
  const debounced = trailingDebounce((v: number) => calls.push(v), 500);

  debounced(1);
  debounced.cancel();
  t.mock.timers.tick(1000);
  assert.deepEqual(calls, []);
});
