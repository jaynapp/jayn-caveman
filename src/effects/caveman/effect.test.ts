import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAVEMAN, CAVEMAN_RATIOS, MID_RUN_PER_TURN, RATIO_SENSITIVITY } from './effect.js';

test('the closing ratio is a single English-measured number, not a language table', () => {
  assert.equal(CAVEMAN_RATIOS.closing, 0.689);
  assert.equal(typeof CAVEMAN_RATIOS.closing, 'number');
});

test('mid-run is measured, and it is the token-mass ratio that gets priced', () => {
  // The per-turn statistic is real and reported, but bills are paid in tokens. Pricing the
  // larger per-turn number would quietly understate what caveman does to a mid-run turn.
  assert.equal(CAVEMAN_RATIOS.midRun, 0.383);
  assert.equal(MID_RUN_PER_TURN, 0.49);
  assert.ok(CAVEMAN_RATIOS.midRun < MID_RUN_PER_TURN, 'token-mass is the lower of the two');
});

test('the headline ratio is labelled benchmarked, with its n', () => {
  assert.equal(CAVEMAN.source, 'benchmarked');
  assert.equal(CAVEMAN.n, 45, '45 English pairs — 90 interactive sessions, two operators');
  assert.equal(CAVEMAN.proseRatio, CAVEMAN_RATIOS.closing);
});

test("the band keeps caveman's own advertised 0.35 in it", () => {
  // Not our old assumption: the published figure, kept so a reader can see how far measuring
  // the thing moved the answer instead of being told.
  assert.ok(
    RATIO_SENSITIVITY.some((s) => s.ratios.closing === 0.35 && s.ratios.midRun === 0.35),
    'the band must still contain 0.35 on both strata',
  );
});

test('every scenario carries two ratios, because the two strata are far apart', () => {
  for (const scenario of RATIO_SENSITIVITY) {
    assert.equal(typeof scenario.ratios.closing, 'number', scenario.label);
    assert.equal(typeof scenario.ratios.midRun, 'number', scenario.label);
  }
  const closings = RATIO_SENSITIVITY.map((s) => s.ratios.closing);
  const midRuns = RATIO_SENSITIVITY.map((s) => s.ratios.midRun);
  assert.notDeepEqual(closings, midRuns, 'a band that moves both strata together tests nothing');
});

test('the band spans the measured pair quartiles', () => {
  const closings = RATIO_SENSITIVITY.map((s) => s.ratios.closing);
  const midRuns = RATIO_SENSITIVITY.map((s) => s.ratios.midRun);
  assert.ok(closings.includes(0.59) && closings.includes(0.77), 'closing IQR 0.59-0.77');
  assert.ok(midRuns.includes(0.15) && midRuns.includes(0.93), 'mid-run IQR 0.15-0.93');
});
