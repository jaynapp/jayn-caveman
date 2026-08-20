import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellOf, fitThresholds, pFireByIndex, type Sample } from './compliance.js';
import {
  asTokenBanded,
  bandDefinitionSweep,
  dominantLanguage,
  leaveOneCorpusOut,
  tokenWeightedPFire,
} from './sensitivity.js';

function sample(overrides: Partial<Sample> = {}): Sample {
  return {
    language: 'en',
    words: 200,
    meanSentenceLength: 16,
    structureShare: 0,
    tokens: 300,
    index: 0,
    lastOfRun: false,
    model: 'claude-opus-5',
    cavemanActive: false,
    ...overrides,
  };
}

const vanilla = (count: number, overrides: Partial<Sample> = {}): Sample[] =>
  Array.from({ length: count }, (_, i) =>
    sample({ meanSentenceLength: 5 + (40 * i) / (count - 1), ...overrides }),
  );

const fires = (count: number, overrides: Partial<Sample> = {}): Sample[] =>
  Array.from({ length: count }, () => sample({ meanSentenceLength: 3, cavemanActive: true, ...overrides }));

const inert = (count: number, overrides: Partial<Sample> = {}): Sample[] =>
  vanilla(count, { cavemanActive: true, ...overrides });

const fit = (subset: readonly Sample[]) => pFireByIndex(subset, fitThresholds(subset));

test('the mean is token-weighted, because that is the weighting the bill uses', () => {
  const control = vanilla(200);
  const curve = fit([...control, ...fires(40)]);
  const samples = [...fires(1, { tokens: 900 }), ...inert(9, { tokens: 12 })];
  const mean = tokenWeightedPFire([...control, ...samples], curve);
  assert.ok(mean !== null && mean > 0.85, `expected the big turn to dominate, got ${mean}`);
});

test('vanilla turns are not averaged in — the rate describes caveman-live prose', () => {
  const control = vanilla(200);
  const curve = fit([...control, ...fires(40)]);
  assert.equal(tokenWeightedPFire([...control, ...fires(40)], curve), tokenWeightedPFire(fires(40), curve));
  assert.equal(tokenWeightedPFire(control, curve), null, 'no ON turns is no answer, not zero');
});

test('the leave-one-out range names which corpus each end belongs to', () => {
  const english = [...vanilla(300), ...fires(40)];
  const french = [...vanilla(200, { language: 'fr' }), ...inert(40, { language: 'fr' })];
  const corpus = new Map<Sample, string>();
  for (const s of english) corpus.set(s, 'alpha');
  for (const s of french) corpus.set(s, 'beta');

  const rows = leaveOneCorpusOut([...english, ...french], (s) => corpus.get(s)!, fit);
  assert.equal(rows.length, 3, 'the point estimate and one row per corpus');
  assert.equal(rows[0]!.omitted, null);
  assert.equal(rows[0]!.language, 'en', 'the corpus as a whole is majority English');

  const withoutFrench = rows.find((r) => r.omitted === 'beta')!;
  const withoutEnglish = rows.find((r) => r.omitted === 'alpha')!;
  assert.equal(withoutFrench.language, 'fr', 'the omitted corpus names the end of the range');
  assert.ok(withoutFrench.meanPFire > rows[0]!.meanPFire + 0.2, 'dropping it must move the answer');
  assert.ok(withoutEnglish.meanPFire < rows[0]!.meanPFire);

  const dropped = rows.slice(1);
  assert.deepEqual(
    dropped.map((r) => r.meanPFire),
    [...dropped.map((r) => r.meanPFire)].sort((a, b) => a - b),
  );
  assert.ok(Math.abs(dropped.reduce((sum, r) => sum + r.share, 0) - 1) < 1e-12, 'shares of ON tokens');
});

test('a single corpus has no composition range, and does not pretend to', () => {
  const only = [...vanilla(200), ...fires(40)];
  assert.deepEqual(
    leaveOneCorpusOut(only, () => 'alpha', fit),
    [],
  );
});

test('omitting a corpus that leaves no caveman turns behind drops the row, not the range', () => {
  const live = [...vanilla(200), ...fires(40)];
  const off = vanilla(200, { model: 'claude-fable-5' });
  const corpus = new Map<Sample, string>();
  for (const s of live) corpus.set(s, 'alpha');
  for (const s of off) corpus.set(s, 'beta');

  const rows = leaveOneCorpusOut([...live, ...off], (s) => corpus.get(s)!, fit);
  assert.deepEqual(
    rows.map((r) => r.omitted),
    [null, 'beta'],
  );
});

test('token banding is reproduced by rescaling, not by a second copy of the edges', () => {
  const base = sample({ words: 200, tokens: 300 });
  const [rebanded] = asTokenBanded([base]);
  assert.notEqual(cellOf(base), cellOf(rebanded!));
  assert.equal(cellOf(base), 'en|4|prose|claude-opus-5');
  assert.equal(cellOf(rebanded!), 'en|3|prose|claude-opus-5');
  assert.equal(rebanded!.meanSentenceLength, base.meanSentenceLength, 'only the size axis moves');
});

test('the band sweep reports both strata under both definitions', () => {
  const samples = [...vanilla(200), ...fires(40), ...fires(40, { lastOfRun: true })];
  const sweep = bandDefinitionSweep(samples, fit);
  for (const at of [sweep.words, sweep.tokens]) {
    assert.ok(at.closing !== null && at.midRun !== null);
  }
});

test('the dominant language ignores turns nothing could be told about', () => {
  const { language, share } = dominantLanguage([
    ...vanilla(3, { language: 'fr', tokens: 100 }),
    ...vanilla(2, { language: 'en', tokens: 100 }),
    ...vanilla(9, { language: 'unknown', tokens: 100 }),
  ]);
  assert.equal(language, 'fr');
  assert.ok(Math.abs(share - 0.6) < 1e-12, 'share is of the SCOREABLE turns');
  assert.deepEqual(dominantLanguage([]), { language: 'unknown', share: 0 });
});
