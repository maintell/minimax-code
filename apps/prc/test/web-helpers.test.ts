import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelay, sameId } from '../web/ids.js';

test('sameId compares ids across string and number representations', () => {
  assert.equal(sameId(1, '1'), true);
  assert.equal(sameId('a', 'a'), true);
  assert.equal(sameId(1, 2), false);
  assert.equal(sameId('1', 2), false);
});

test('backoffDelay doubles and caps at thirty seconds', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].map((attempt) => backoffDelay(attempt)),
    [1_500, 3_000, 6_000, 12_000, 24_000, 30_000, 30_000],
  );
});
