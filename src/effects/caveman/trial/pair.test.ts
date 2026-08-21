import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateCell, type Pair, type TrialTurn } from './pair.js';

function midRun(tokens: number): TrialTurn {
  return {
    index: 0,
    cell: 'mid-run',
    onlyTextBlocks: true,
    tokens,
    words: tokens,
    meanSentenceLength: Number.NaN,
    structureShare: 0,
    language: 'en',
    model: 'claude-opus-5',
    scorable: tokens >= 10,
  };
}

function pair(onTokens: number, offTokens: number): Pair {
  return {
    promptId: 'prompt',
    model: 'claude-opus-5',
    repeat: 0,
    on: [midRun(onTokens)],
    off: [midRun(offTokens)],
  };
}

test('pooled mid-run R keeps pairs whose control has zero prose', () => {
  const estimate = estimateCell([pair(0, 8), pair(8, 0)], 'mid-run');

  assert.equal(estimate.onTokens, 8);
  assert.equal(estimate.offTokens, 8);
  assert.equal(estimate.onTurns, 2);
  assert.equal(estimate.offTurns, 2);
  assert.equal(estimate.perTurn.pooled, 1);
  assert.equal(estimate.pairs, 1);
  assert.equal(estimate.dropped, 1);
});
