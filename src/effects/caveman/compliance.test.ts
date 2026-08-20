import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANY_LANGUAGE,
  ANY_MODEL,
  armBalance,
  C_LAST,
  CELL_VERSION,
  cellCompatibility,
  cellOf,
  cellCoverage,
  coverageOf,
  creditCorpora,
  deserialiseThresholds,
  evaluatePrior,
  fitFloors,
  fitThresholds,
  floorsFrom,
  isTerse,
  lookupCutoff,
  lookupFloor,
  mergeThresholds,
  modelFamily,
  pFireByIndex,
  serialiseThresholds,
  shiftedPair,
  terseness,
  type PFirePrior,
  type Sample,
  type ThresholdFile,
} from './compliance.js';

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

function vanilla(count: number, from: number, to: number, overrides: Partial<Sample> = {}): Sample[] {
  return Array.from({ length: count }, (_, i) =>
    sample({ meanSentenceLength: from + ((to - from) * i) / (count - 1), ...overrides }),
  );
}

test('thresholds are fitted from vanilla turns only', () => {
  const thresholds = fitThresholds([...vanilla(40, 10, 30), ...vanilla(40, 1, 2, { cavemanActive: true })]);
  const cutoff = thresholds.cutoff.get(cellOf(sample())!);
  assert.ok(cutoff !== undefined && cutoff > 5, `caveman turns leaked into the fit: ${cutoff}`);
});

test('the vanilla false-positive rate lands at the quantile by construction', () => {
  const turns = vanilla(100, 5, 40);
  const thresholds = fitThresholds(turns);
  const terse = turns.filter((t) => isTerse(t, thresholds)).length;
  assert.ok(Math.abs(terse / turns.length - 0.25) < 0.05, `floor drifted: ${terse / turns.length}`);
});

test('language, size and structure each get their own cell', () => {
  const base = sample();
  assert.notEqual(cellOf(base), cellOf({ ...base, language: 'fr' }));
  assert.notEqual(cellOf(base), cellOf({ ...base, words: 30 }));
  assert.notEqual(cellOf(base), cellOf({ ...base, structureShare: 0.9 }));
});

test('the cell is decided by words, so it does not move with the tokenizer', () => {
  const base = sample({ tokens: 300 });
  const rebilled = sample({ ...base, tokens: 3000 });
  assert.equal(cellOf(base), cellOf(rebilled));
});

test('a turn with no covering threshold is unscored, never guessed', () => {
  const thresholds = fitThresholds(vanilla(40, 10, 30));
  assert.equal(isTerse(sample({ language: 'fr' }), thresholds), null);
  assert.equal(isTerse(sample({ meanSentenceLength: Number.NaN }), thresholds), null);
});

test('a thin vanilla cell produces no threshold at all', () => {
  assert.equal(fitThresholds(vanilla(5, 10, 30)).cutoff.size, 0);
});

test('p_fire subtracts the measured floor rather than assuming none', () => {
  const control = vanilla(200, 5, 45);
  const thresholds = fitThresholds(control);

  const on = Array.from({ length: 40 }, () => sample({ meanSentenceLength: 3, cavemanActive: true }));
  const bin = pFireByIndex([...control, ...on], thresholds).pooled[0]!;
  assert.ok(bin.pFire !== null && bin.pFire > 0.95, `expected ~1, got ${bin.pFire}`);
  assert.ok(bin.offRate > 0.15 && bin.offRate < 0.35, `floor should be visible: ${bin.offRate}`);
});

test('ON turns indistinguishable from vanilla give p_fire ~0, not a small positive', () => {
  const control = vanilla(200, 5, 45);
  const thresholds = fitThresholds(control);
  const on = vanilla(40, 5, 45).map((t) => ({ ...t, cavemanActive: true }));
  const bin = pFireByIndex([...control, ...on], thresholds).pooled[0]!;
  assert.ok(bin.pFire !== null && bin.pFire < 0.1, `expected ~0, got ${bin.pFire}`);
});

test('a bin without enough turns reports null instead of a number', () => {
  const control = vanilla(200, 5, 45);
  const thresholds = fitThresholds(control);
  const on = [sample({ meanSentenceLength: 3, cavemanActive: true, index: 50 })];
  const curve = pFireByIndex([...control, ...on], thresholds);
  assert.equal(curve.pooled.find((b) => b.from === 40)?.pFire, null);
});

test('a corpus that always ran caveman still scores, by borrowing shipped cutoffs', () => {
  const shipped = fitThresholds(vanilla(200, 5, 45));
  const own = [
    ...vanilla(5, 10, 30),
    ...Array.from({ length: 30 }, () => sample({ meanSentenceLength: 4, cavemanActive: true })),
  ];
  assert.equal(fitThresholds(own).cutoff.size, 0, 'local fit should be empty here');

  const merged = mergeThresholds(fitThresholds(own), shipped);
  assert.ok(merged.cutoff.size > 0);
  assert.equal(merged.origin.get(cellOf(sample())!), 'shipped');
  assert.equal(coverageOf(own, merged).noThreshold, 0);
});

test('a local cutoff wins over the shipped one for the same cell', () => {
  const shipped = fitThresholds(vanilla(200, 5, 45));
  const local = fitThresholds(vanilla(40, 30, 60));
  const merged = mergeThresholds(local, shipped);
  const cell = cellOf(sample())!;
  assert.equal(merged.origin.get(cell), 'local');
  assert.equal(merged.cutoff.get(cell), local.cutoff.get(cell));
});

test('coverage separates a missing threshold from a turn with no prose sentence', () => {
  const thresholds = fitThresholds(vanilla(40, 10, 30));
  const coverage = coverageOf(
    [sample(), sample({ language: 'fr' }), sample({ meanSentenceLength: Number.NaN })],
    thresholds,
  );
  assert.deepEqual(coverage, {
    scored: 1,
    unscored: 2,
    noThreshold: 1,
    noSentence: 1,
    borrowedCutoffs: 0,
  });
});

test('serialising thresholds round-trips them', () => {
  const thresholds = fitThresholds(vanilla(40, 10, 30));
  const back = deserialiseThresholds(
    serialiseThresholds(thresholds, [{ id: 'corpus-a', vanillaTurns: 40 }], []),
  );
  const sorted = (map: ReadonlyMap<string, number>) => [...map].sort(([a], [b]) => a.localeCompare(b));
  assert.deepEqual(sorted(back.cutoff), sorted(thresholds.cutoff));
});

test('the shipped registry credits corpora by opaque id, never by name', () => {
  const credits = creditCorpora(
    new Map([
      ['corpus-pierre', 12],
      ['friend-python', 34],
      ['cofounder', 56],
    ]),
  );
  const serialised = JSON.stringify(credits);
  for (const name of ['pierre', 'friend', 'cofounder']) {
    assert.ok(!serialised.includes(name), `local label leaked into the registry: ${name}`);
  }
  assert.deepEqual(
    credits.map((c) => c.id),
    ['corpus-a', 'corpus-b', 'corpus-c'],
  );

  assert.deepEqual(
    credits.map((c) => c.vanillaTurns).sort((a, b) => a - b),
    [12, 34, 56],
  );
});

test('grid coverage reports empty cells, not only fitted ones, per model family', () => {
  const thresholds = fitThresholds(vanilla(40, 10, 30));
  const rows = cellCoverage(vanilla(40, 10, 30), thresholds);

  assert.equal(rows.length, 48, 'the whole grid should be reported, once per family');
  const fitted = rows.find((r) => r.cell === cellOf(sample())!)!;
  assert.equal(fitted.fitted, true);
  assert.equal(fitted.needed, 0);
  assert.equal(fitted.model, 'claude-opus-5');
  assert.ok(
    rows.find((r) => r.cell === `en|4|prose|${ANY_MODEL}`)!.fitted,
    'the roll-up is fitted from the same turns',
  );
  const empty = rows.find((r) => r.cell === `fr|0|list|${ANY_MODEL}`)!;
  assert.equal(empty.fitted, false);
  assert.equal(empty.needed, 20);
});

test('coverage ranks a gap by the caveman turns it blocks, not by how empty it is', () => {
  const blocked = Array.from({ length: 7 }, () =>
    sample({ words: 800, meanSentenceLength: 5, cavemanActive: true }),
  );
  const rows = cellCoverage([...vanilla(40, 10, 30), ...blocked], fitThresholds(vanilla(40, 10, 30)));
  const gap = rows.find((r) => r.cell === `en|5|prose|${ANY_MODEL}`)!;
  assert.equal(gap.fitted, false);
  assert.equal(gap.blocked, 7);
  assert.equal(rows.find((r) => r.cell === `en|0|list|${ANY_MODEL}`)!.blocked, 0);
});

test('a family with no cutoff of its own is rescued by the roll-up, not counted as blocked', () => {
  const control = vanilla(40, 10, 30);
  const stranger = sample({ model: 'claude-fable-5', meanSentenceLength: 4, cavemanActive: true });
  const thresholds = fitThresholds(control);
  const rows = cellCoverage([...control, stranger], thresholds);

  const own = rows.find((r) => r.cell === 'en|4|prose|claude-fable-5')!;
  assert.equal(own.fitted, false, 'fable-5 has no vanilla writing here');
  assert.equal(own.blocked, 0, 'but the roll-up scores it anyway');

  const hit = lookupCutoff(thresholds, stranger);
  assert.ok(hit !== null && !hit.exact, 'and the borrow is visible');
  assert.equal(terseness(stranger, thresholds)?.exact, false);
  assert.equal(coverageOf([stranger], thresholds).borrowedCutoffs, 1);
});

test('a cutoff is fitted per model family, and the roll-up over all of them', () => {
  const terseFamily = vanilla(40, 4, 16, { model: 'claude-opus-5' });
  const verboseFamily = vanilla(40, 8, 24, { model: 'claude-opus-4-8' });
  const thresholds = fitThresholds([...terseFamily, ...verboseFamily]);

  const opus5 = thresholds.cutoff.get('en|4|prose|claude-opus-5')!;
  const opus48 = thresholds.cutoff.get('en|4|prose|claude-opus-4-8')!;
  const rollup = thresholds.cutoff.get(`en|4|prose|${ANY_MODEL}`)!;
  assert.ok(opus5 < opus48, `${opus5} should sit below ${opus48}`);
  assert.ok(rollup > opus5 && rollup < opus48, `the roll-up (${rollup}) sits between them`);

  assert.equal(thresholds.support.get(`en|4|prose|${ANY_MODEL}`), 80);
  assert.notEqual(rollup, (opus5 + opus48) / 2);

  const between = (opus5 + rollup) / 2;
  const turn = sample({ model: 'claude-opus-5', meanSentenceLength: between, cavemanActive: true });
  assert.equal(terseness(turn, thresholds)?.terse, false, 'not terse for an Opus 5 turn');
  assert.ok(between < rollup, 'but it would have been under the pooled cutoff');
});

test('the arm balance is printed from turn counts, and flags a family the arms disagree on', () => {
  const balance = armBalance([
    ...Array.from({ length: 80 }, () => sample({ cavemanActive: true, model: 'claude-opus-5' })),
    ...Array.from({ length: 20 }, () => sample({ cavemanActive: true, model: 'claude-opus-4-8' })),
    ...Array.from({ length: 20 }, () => sample({ model: 'claude-opus-5' })),
    ...Array.from({ length: 80 }, () => sample({ model: 'claude-opus-4-8' })),
  ]);
  assert.equal(balance.onTurns, 100);
  assert.equal(balance.offTurns, 100);
  const opus5 = balance.rows.find((r) => r.model === 'claude-opus-5')!;
  assert.ok(Math.abs(opus5.gap - 0.6) < 1e-9, `${opus5.gap}`);
  assert.equal(balance.imbalanced, true);

  const oneArm = armBalance(Array.from({ length: 20 }, () => sample({ cavemanActive: true })));
  assert.equal(oneArm.imbalanced, false);
  assert.equal(oneArm.offTurns, 0);
});

test('the correction is quantile-invariant when the detector is perfect', () => {
  const control = vanilla(400, 5, 45);
  const on = Array.from({ length: 60 }, (_, i) =>
    i % 2 === 0
      ? sample({ meanSentenceLength: 1, cavemanActive: true })
      : sample({ meanSentenceLength: 5 + (40 * i) / 60, cavemanActive: true }),
  );
  for (const q of [0.1, 0.25, 0.5]) {
    const thresholds = fitThresholds(control, q);
    const bin = pFireByIndex([...control, ...on], thresholds).pooled[0]!;
    assert.ok(
      bin.pFire !== null && Math.abs(bin.pFire - 0.5) < 0.12,
      `q=${q} should recover ~0.5, got ${bin.pFire}`,
    );
  }
});

test('a serialised registry records the quantile it was fitted at', () => {
  const file = serialiseThresholds(fitThresholds(vanilla(40, 10, 30), 0.4), [], [], 0.4);
  assert.equal(file.quantile, 0.4);
});

function mirroredControl(count: number, from: number, to: number): Sample[] {
  return Array.from({ length: count }, (_, i) => {
    const meanSentenceLength = from + ((to - from) * Math.floor(i / 2)) / (count / 2 - 1);
    return sample({ meanSentenceLength, lastOfRun: i % 2 === 0 });
  });
}

const on = (count: number, meanSentenceLength: number, lastOfRun: boolean): Sample[] =>
  Array.from({ length: count }, () => sample({ meanSentenceLength, lastOfRun, cavemanActive: true }));

test('the curve splits on lastOfRun, in the direction the corpus says', () => {
  const thresholds = fitThresholds(mirroredControl(200, 5, 45));
  const curve = pFireByIndex(
    [...mirroredControl(200, 5, 45), ...on(40, 3, true), ...on(40, 40, false)],
    thresholds,
  );
  const closing = curve.byPosition.closing[0]!;
  const midRun = curve.byPosition.midRun[0]!;
  assert.ok(closing.pFire !== null && midRun.pFire !== null);
  assert.ok(closing.pFire > midRun.pFire, `${closing.pFire} should exceed ${midRun.pFire}`);
  assert.ok(closing.pFire > 0.95 && midRun.pFire < 0.05);
  assert.equal(closing.method, 'measured');
  assert.equal(midRun.method, 'measured');
});

test('the pooled row is the mixture of the two strata at its own reported mix', () => {
  const control = mirroredControl(200, 5, 45);
  const thresholds = fitThresholds(control);
  const samples = [
    ...control,
    ...on(20, 3, true),
    ...on(20, 40, true),
    ...on(16, 3, false),
    ...on(24, 40, false),
  ];
  const curve = pFireByIndex(samples, thresholds);
  const pooled = curve.pooled[0]!;
  const closing = curve.byPosition.closing[0]!;
  const midRun = curve.byPosition.midRun[0]!;

  const w = closing.onTurns / (closing.onTurns + midRun.onTurns);
  assert.equal(w, pooled.closingShare, 'the printed mix must be the mix the rate was taken at');
  const mix = (pick: (b: typeof pooled) => number) => w * pick(closing) + (1 - w) * pick(midRun);
  assert.ok(Math.abs(pooled.onRate - mix((b) => b.onRate)) < 1e-12);
  assert.ok(Math.abs(pooled.offRate - mix((b) => b.offRate)) < 1e-12);

  assert.ok(Math.abs(pooled.pFire! - mix((b) => b.pFire!)) < 1e-12, `${pooled.pFire}`);
});

test('the c shift reproduces the pooled rate when mixed back at its own share', () => {
  for (const pooled of [0.1, 0.35, 0.62, 0.9]) {
    for (const w of [0.05, 0.275, 0.5, 0.9]) {
      const { closing, midRun } = shiftedPair(pooled, w);
      assert.ok(
        Math.abs(w * closing + (1 - w) * midRun - pooled) < 1e-9,
        `p=${pooled} w=${w} remixed to ${w * closing + (1 - w) * midRun}`,
      );
      const gap = Math.log(closing / (1 - closing)) - Math.log(midRun / (1 - midRun));
      assert.ok(Math.abs(gap - C_LAST) < 1e-6, `gap was ${gap}, not ${C_LAST}`);
      assert.ok(closing > pooled && pooled > midRun);
    }
  }
});

test('a stratum with no turns at all takes the whole pooled rate, not half of it', () => {
  const at0 = shiftedPair(0.4, 0);
  assert.ok(Math.abs(at0.midRun - 0.4) < 1e-12, 'the observed stratum keeps the observed rate');
  assert.ok(at0.closing > 0.4);

  const at1 = shiftedPair(0.4, 1);
  assert.ok(Math.abs(at1.closing - 0.4) < 1e-12);
  assert.ok(at1.midRun < 0.4);

  assert.deepEqual(shiftedPair(0, 0.5), { closing: 0, midRun: 0 });
  assert.deepEqual(shiftedPair(1, 0.5), { closing: 1, midRun: 1 });
});

test('a dated model snapshot keys to its family, so it shares one floor', () => {
  assert.equal(modelFamily('claude-opus-5-20260101'), 'claude-opus-5');
  assert.equal(modelFamily('claude-opus-5'), 'claude-opus-5');
  assert.equal(modelFamily(''), 'unknown');

  const control = mirroredControl(200, 5, 45).map((s) => ({ ...s, model: 'claude-opus-5-20260101' }));
  const thresholds = fitThresholds(control);
  const curve = pFireByIndex([...control, ...on(40, 3, true)], thresholds);
  assert.equal(curve.byPosition.closing[0]!.floorFallbacks, 0, 'the family floor should have matched');
});

test('an unseen model family falls back to the language x position floor and says so', () => {
  const control = mirroredControl(200, 5, 45);
  const thresholds = fitThresholds(control);
  const strangers = on(40, 3, true).map((s) => ({ ...s, model: 'claude-fable-5' }));
  const closing = pFireByIndex([...control, ...strangers], thresholds).byPosition.closing[0]!;

  assert.equal(closing.floorFallbacks, closing.onTurns, 'every turn should have borrowed');
  assert.equal(closing.unfloored, 0, 'borrowing is not the same as having no floor');
  assert.ok(closing.pFire !== null, 'the correction still runs');

  const floors = floorsFrom(fitFloors(control, thresholds));
  const hit = lookupFloor(floors, { bin: 0, language: 'en', lastOfRun: true, model: 'claude-fable-5' });
  assert.equal(hit?.exact, false);
  const own = lookupFloor(floors, { bin: 0, language: 'en', lastOfRun: true, model: 'claude-opus-5' });
  assert.equal(own?.exact, true);
});

test('a turn with no floor at any specificity is dropped, never charged zero', () => {
  const control = mirroredControl(200, 5, 45);
  const thresholds = fitThresholds(control);
  const french = on(40, 3, true).map((s) => ({ ...s, language: 'fr' as const }));

  const cutoff = thresholds.cutoff.get(`en|4|prose|${ANY_MODEL}`)!;
  const patched = {
    cutoff: new Map(thresholds.cutoff).set(`fr|4|prose|${ANY_MODEL}`, cutoff),
    support: new Map(thresholds.support).set(`fr|4|prose|${ANY_MODEL}`, 200),
  };
  const closing = pFireByIndex([...control, ...french], patched).byPosition.closing[0]!;
  assert.equal(closing.unfloored, 40);
  assert.equal(closing.onTurns, 0);
  assert.equal(closing.floorOrigin, 'none');
});

test('the ANY_MODEL roll-up is a rate over turns, not an average of the per-model rates', () => {
  const control = [
    ...mirroredControl(200, 5, 45),
    ...mirroredControl(20, 1, 3).map((s) => ({ ...s, model: 'claude-haiku-4-5' })),
  ];
  const rows = fitFloors(control, fitThresholds(control));
  const rolled = rows.find((r) => r.bin === 0 && r.model === ANY_MODEL && r.position === 'last')!;
  const opus = rows.find((r) => r.bin === 0 && r.model === 'claude-opus-5' && r.position === 'last')!;
  const haiku = rows.find((r) => r.bin === 0 && r.model === 'claude-haiku-4-5' && r.position === 'last')!;

  assert.equal(rolled.support, opus.support + haiku.support);
  const byTurns = (opus.rate * opus.support + haiku.rate * haiku.support) / rolled.support;
  assert.ok(Math.abs(rolled.rate - byTurns) < 1e-12);
  assert.notEqual(rolled.rate, (opus.rate + haiku.rate) / 2);
});

test('a registry from an older cell definition is refused, not adapted', () => {
  const legacy = { cells: {}, corpora: [], quantile: 0.25, fittedAt: '', floors: [] } as ThresholdFile;
  const untyped = cellCompatibility(legacy);
  assert.equal(untyped.ok, false);
  assert.match(untyped.reason!, /token size-bands/);

  const v2 = cellCompatibility({ ...legacy, cellVersion: 2 });
  assert.equal(v2.ok, false);
  assert.match(v2.reason!, /pooled across model families/);

  const future = cellCompatibility({ ...legacy, cellVersion: CELL_VERSION + 1 });
  assert.equal(future.ok, false);
  assert.match(future.reason!, new RegExp(`this build reads ${CELL_VERSION}`));

  assert.deepEqual(cellCompatibility({ ...legacy, cellVersion: CELL_VERSION }), {
    ok: true,
    reason: null,
  });
});

const prior = (level: PFirePrior['level']): PFirePrior => ({
  level,
  c: 1.8,
  cCI: [1.5, 2.1],
  b: -0.6,
  bCI: [-0.8, -0.4],
  compositionRange: [0.42, 0.55],
  fittedOn: { model: 'claude-opus-5', onTurns: 1000, offTurns: 2000, contributors: 3, dropped: 0 },
  binDisagreement: null,
});

test('the prior is a logistic in language, position and depth', () => {
  const model = prior({ en: { a: 1.36, support: 773, contributors: 3 } });
  const at = (lastOfRun: boolean, index: number) =>
    evaluatePrior(model, { language: 'en', lastOfRun, index });

  for (const index of [0, 20, 400]) {
    const gap =
      Math.log(at(true, index) / (1 - at(true, index))) - Math.log(at(false, index) / (1 - at(false, index)));
    assert.ok(Math.abs(gap - model.c) < 1e-9, `gap at ${index} was ${gap}`);
  }

  assert.ok(at(true, 400) < at(true, 80));
  assert.ok(at(false, 0) > at(false, 400));
});

test('an undetectable language takes the corpus-weighted level, never English', () => {
  const model = prior({
    en: { a: 2, support: 700, contributors: 3 },
    fr: { a: -1, support: 300, contributors: 1 },
    [ANY_LANGUAGE]: { a: 1, support: 1000, contributors: 3 },
  });
  const unknown = evaluatePrior(model, { language: 'unknown', lastOfRun: false, index: 0 });
  assert.equal(unknown, evaluatePrior(model, { language: ANY_LANGUAGE, lastOfRun: false, index: 0 }));
  assert.ok(unknown < evaluatePrior(model, { language: 'en', lastOfRun: false, index: 0 }));
  assert.ok(unknown > evaluatePrior(model, { language: 'fr', lastOfRun: false, index: 0 }));
});

test('a serialised registry carries the cell version and its floors round-trip', () => {
  const control = mirroredControl(200, 5, 45);
  const thresholds = fitThresholds(control);
  const file = serialiseThresholds(thresholds, [], fitFloors(control, thresholds));
  assert.equal(file.cellVersion, CELL_VERSION);
  assert.ok(file.floors.length > 0);

  const back = floorsFrom(file.floors);
  const hit = lookupFloor(back, { bin: 0, language: 'en', lastOfRun: true, model: 'claude-opus-5' });
  assert.ok(hit !== null && hit.exact && hit.rate > 0.15 && hit.rate < 0.35);
});
