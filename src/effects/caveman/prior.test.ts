import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANY_LANGUAGE,
  ANY_MODEL,
  evaluatePrior,
  fitFloors,
  fitThresholds,
  floorsFrom,
  type Sample,
} from './compliance.js';
import { dominantFamily, fitPrior, rowsFromSamples, runsOf, type PriorRow } from './prior.js';

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

function randomiser(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TRUE = { a: 1.2, c: 1.8, b: -0.65 };

function corpus(): Sample[] {
  const random = randomiser(0x51ded);
  const control: Sample[] = [];
  for (let i = 0; i < 1500; i++) {
    control.push(
      sample({
        meanSentenceLength: 5 + 40 * random(),
        index: Math.floor(random() * 100),
        lastOfRun: random() < 0.5,
      }),
    );
  }
  const live: Sample[] = [];
  for (let i = 0; i < 1500; i++) {
    const lastOfRun = random() < 0.5;
    const index = Math.floor(random() * 100);
    const p = 1 / (1 + Math.exp(-(TRUE.a + TRUE.c * (lastOfRun ? 1 : 0) + TRUE.b * Math.log(1 + index))));
    const fires = random() < p;
    live.push(
      sample({
        meanSentenceLength: fires ? 1 : 5 + 40 * random(),
        index,
        lastOfRun,
        cavemanActive: true,
      }),
    );
  }
  return [...control, ...live];
}

function fitFrom(samples: readonly Sample[], group: (s: Sample) => string = () => 'a') {
  const thresholds = fitThresholds(samples);
  return fitPrior(rowsFromSamples(samples, group), thresholds, floorsFrom(fitFloors(samples, thresholds)));
}

test('runs are reconstructed from the index resetting, not from a session id', () => {
  assert.deepEqual(runsOf([{ index: 0 }, { index: 1 }, { index: 2 }]), [0, 0, 0]);
  assert.deepEqual(runsOf([{ index: 0 }, { index: 1 }, { index: 0 }, { index: 4 }]), [0, 0, 1, 1]);

  assert.deepEqual(runsOf([{ index: 3 }, { index: 3 }]), [0, 1]);

  assert.deepEqual(runsOf([{ index: 0 }, { index: 0 }], 7), [7, 8]);
});

test('the prior recovers the parameters it was generated with, through the floor', () => {
  const prior = fitFrom(corpus());
  assert.ok(prior !== null, 'a corpus this well sampled must fit');
  assert.ok(Math.abs(prior.c - TRUE.c) < 0.4, `c was ${prior.c}, generated at ${TRUE.c}`);
  assert.ok(Math.abs(prior.b - TRUE.b) < 0.25, `b was ${prior.b}, generated at ${TRUE.b}`);

  assert.ok(Math.abs(prior.level.en!.a - TRUE.a) < 0.5, `a was ${prior.level.en!.a}`);

  const at = (lastOfRun: boolean, index: number) =>
    evaluatePrior(prior, { language: 'en', lastOfRun, index });
  assert.ok(at(true, 0) > at(false, 0), 'closing fires more often at turn 0');
  assert.ok(at(true, 90) < at(true, 0), 'and less often deep into a session');
});

test('the recorded bin-vs-formula gap is the size of the smoothness assumption', () => {
  const prior = fitFrom(corpus())!;
  assert.ok(prior.binDisagreement !== null, 'a corpus this size has cells to compare');
  assert.ok(
    prior.binDisagreement.gap < 0.15,
    `data generated from the model should not disagree with it by ${prior.binDisagreement.gap}`,
  );
});

test('the interval is a cluster bootstrap, so it is wider than a per-turn one would be', () => {
  const prior = fitFrom(corpus())!;
  assert.ok(prior.bCI[0] < prior.b && prior.b < prior.bCI[1], 'the interval brackets the estimate');
  assert.ok(prior.cCI[0] < prior.c && prior.c < prior.cCI[1]);

  assert.ok(prior.cCI[1] - prior.cCI[0] > 0.01, `c interval was ${prior.cCI}`);
});

test('the fit is deterministic, so a registry rebuild is reproducible', () => {
  const samples = corpus();
  assert.deepEqual(fitFrom(samples), fitFrom(samples));
});

test('a language below the support floor shares the pooled level instead of getting its own', () => {
  const samples = [
    ...corpus(),
    ...Array.from({ length: 12 }, (_, i) =>
      sample({ language: 'fr', meanSentenceLength: 4, index: i, cavemanActive: true }),
    ),

    ...Array.from({ length: 60 }, (_, i) =>
      sample({ language: 'fr', meanSentenceLength: 6 + (30 * (i % 30)) / 29, index: i % 30 }),
    ),
  ];
  const prior = fitFrom(samples)!;
  assert.equal(prior.level.fr, undefined, 'twelve turns do not earn a level');
  assert.ok(prior.level.en !== undefined);
  assert.ok(prior.level[ANY_LANGUAGE] !== undefined);

  assert.equal(
    evaluatePrior(prior, { language: 'fr', lastOfRun: true, index: 0 }),
    evaluatePrior(prior, { language: ANY_LANGUAGE, lastOfRun: true, index: 0 }),
  );
});

test('the level records how many contributors stand behind it, so one person is visible', () => {
  const samples = corpus();
  const prior = fitFrom(samples, (s) => (s.index % 3 === 0 ? 'alice' : 'bob'))!;
  assert.equal(prior.level.en!.contributors, 2);
  assert.equal(prior.fittedOn.contributors, 2);
  assert.equal(prior.level.en!.support, prior.fittedOn.onTurns);
});

test('the composition range is a leave-one-contributor-out width, not a sampling interval', () => {
  const alone = fitFrom(corpus())!;
  assert.equal(alone.compositionRange[0], alone.compositionRange[1], 'one contributor has no width');

  const shared = fitFrom(corpus(), (s) => (s.index % 3 === 0 ? 'alice' : 'bob'))!;
  assert.ok(shared.compositionRange[0] < shared.compositionRange[1], 'two contributors do');
});

test('the prior is fitted on one model family, and says which', () => {
  const mixed = [
    ...corpus(),
    ...Array.from({ length: 300 }, (_, i) =>
      sample({
        model: 'claude-fable-5',
        meanSentenceLength: 4,
        index: i % 50,
        lastOfRun: i % 2 === 0,
        cavemanActive: true,
      }),
    ),
  ];
  const opusLive = mixed.filter((s) => s.cavemanActive && s.model === 'claude-opus-5').length;
  const prior = fitFrom(mixed)!;
  assert.equal(prior.fittedOn.model, 'claude-opus-5', 'the family with the most caveman turns');
  assert.equal(prior.fittedOn.onTurns, prior.level[ANY_LANGUAGE]!.support);
  assert.equal(
    prior.fittedOn.onTurns + prior.fittedOn.dropped,
    opusLive,
    'the 300 fable-5 turns are not in the fit',
  );
});

test('dominantFamily counts caveman-live turns only, since that is what the level describes', () => {
  const rows: PriorRow[] = [
    ...Array.from({ length: 100 }, () => row({ model: 'claude-opus-4-8', caveman: false })),
    ...Array.from({ length: 10 }, () => row({ model: 'claude-opus-5', caveman: true })),
    ...Array.from({ length: 4 }, () => row({ model: 'claude-fable-5', caveman: true })),
  ];
  assert.equal(dominantFamily(rows), 'claude-opus-5');
  assert.equal(dominantFamily([]), null, 'nothing to describe is not a family');
});

function row(overrides: Partial<PriorRow> = {}): PriorRow {
  return {
    lang: 'en',
    band: 4,
    shape: 'prose',
    sentLen: 12,
    index: 0,
    last: false,
    model: 'claude-opus-5',
    caveman: false,
    group: 'a',
    run: 0,
    ...overrides,
  };
}

test('an unscoreable turn is dropped from the fit and counted, not scored on a guess', () => {
  const samples = [
    ...corpus(),

    ...Array.from({ length: 30 }, (_, i) =>
      sample({ language: 'fr', meanSentenceLength: 4, index: i, cavemanActive: true }),
    ),
  ];
  const prior = fitFrom(samples)!;
  assert.equal(prior.fittedOn.dropped, 30);
});

test('a rolled-up cutoff still scores a turn whose own family has none', () => {
  const samples = corpus();
  const thresholds = fitThresholds(samples);
  assert.ok(thresholds.cutoff.has(`en|4|prose|${ANY_MODEL}`));
  assert.ok(!thresholds.cutoff.has('en|4|prose|claude-fable-5'));

  const rows = rowsFromSamples(samples, () => 'a').map((r) =>
    r.caveman ? { ...r, model: 'claude-fable-5' } : r,
  );
  const prior = fitPrior(rows, thresholds, floorsFrom(fitFloors(samples, thresholds)), 'claude-fable-5');
  assert.ok(prior !== null, 'the roll-up scores them');
  assert.equal(prior.fittedOn.model, 'claude-fable-5');
  assert.equal(prior.fittedOn.dropped, 0);
});
