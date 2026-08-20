import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAVEMAN, CAVEMAN_RATIOS, closingRatio, RATIO_SENSITIVITY } from './effect.js';

test('the closing ratio is keyed on the language of the turn', () => {
  assert.equal(closingRatio(CAVEMAN_RATIOS, 'en'), 0.83);
  assert.equal(closingRatio(CAVEMAN_RATIOS, 'fr'), 0.54);
  assert.ok(closingRatio(CAVEMAN_RATIOS, 'fr') < closingRatio(CAVEMAN_RATIOS, 'en'));
});

test('an undetected language falls back to the pooled ratio, never to a default arm', () => {
  assert.equal(closingRatio(CAVEMAN_RATIOS, 'unknown'), 0.71);
  assert.equal(closingRatio(CAVEMAN_RATIOS, 'de'), 0.71, 'an unmeasured language borrows the pool');
  assert.equal(closingRatio(CAVEMAN_RATIOS, ''), 0.71);
});

test('the headline ratio is labelled benchmarked, with its n', () => {
  assert.equal(CAVEMAN.source, 'benchmarked');
  assert.equal(CAVEMAN.n, 15);
  assert.equal(CAVEMAN.proseRatio, CAVEMAN_RATIOS.closing.unknown);
});

test('the sensitivity band keeps the old assumption in it', () => {
  assert.ok(
    RATIO_SENSITIVITY.some((s) => s.ratios.closing.en === 0.35),
    'the band must still contain 0.35',
  );
});

test('the mid-run corners span 1.0, because expansion was not excluded', () => {
  const corners = RATIO_SENSITIVITY.filter((s) => s.corner).map((s) => s.ratios.midRun);
  assert.ok(Math.min(...corners) < 1, 'a corner below 1');
  assert.ok(Math.max(...corners) > 1, 'a corner above 1 — expansion is inside the band');
});
