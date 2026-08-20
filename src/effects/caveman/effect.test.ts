import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAVEMAN, CAVEMAN_RATIOS, RATIO_SENSITIVITY } from './effect.js';

test('the closing ratio is a single English-measured number, not a language table', () => {
  assert.equal(CAVEMAN_RATIOS.closing, 0.83);
  assert.equal(typeof CAVEMAN_RATIOS.closing, 'number');
});

test('the headline ratio is labelled benchmarked, with its n', () => {
  assert.equal(CAVEMAN.source, 'benchmarked');
  assert.equal(CAVEMAN.n, 9, 'nine English pairs — one repeat each, no replication');
  assert.equal(CAVEMAN.proseRatio, CAVEMAN_RATIOS.closing);
});

test('the sensitivity band keeps the old assumption in it', () => {
  assert.ok(
    RATIO_SENSITIVITY.some((s) => s.ratios.closing === 0.35),
    'the band must still contain 0.35',
  );
});

test('the band spans the measured IQR', () => {
  const closings = RATIO_SENSITIVITY.map((s) => s.ratios.closing);
  assert.ok(Math.min(...closings) <= 0.73, 'reaches the measured IQR floor');
  assert.ok(Math.max(...closings) >= 0.91, 'reaches the measured IQR ceiling');
});

test('the mid-run corners span 1.0, because expansion was not excluded', () => {
  const corners = RATIO_SENSITIVITY.filter((s) => s.corner).map((s) => s.ratios.midRun);
  assert.ok(Math.min(...corners) < 1, 'a corner below 1');
  assert.ok(Math.max(...corners) > 1, 'a corner above 1 — expansion is inside the band');
});
