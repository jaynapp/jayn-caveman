import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANY_LANGUAGE, INDEX_BINS, type Bin, type PFireCurve, type PFirePrior } from './compliance.js';
import { isUsable, isUsablePrior, pFireAt, pFireWithSource } from './pfire.js';

function bin(pFire: number | null, index: number): Bin {
  const [from, to] = INDEX_BINS[index]!;
  return {
    from,
    to,
    onTurns: pFire === null ? 0 : 20,
    offTurns: 40,
    onRate: Number.NaN,
    offRate: Number.NaN,
    floorOrigin: 'local',
    floorFallbacks: 0,
    unfloored: 0,
    closingShare: 0.5,
    pFire,
    method: pFire === null ? 'none' : 'measured',
  };
}

const curve = (
  closing: (number | null)[],
  midRun: (number | null)[],
  pooled: (number | null)[],
): PFireCurve => ({
  byPosition: { closing: closing.map(bin), midRun: midRun.map(bin) },
  pooled: pooled.map(bin),
});

const NONE: (number | null)[] = INDEX_BINS.map(() => null);
const NOTHING = curve(NONE, NONE, NONE);

const turn = (index: number, lastOfRun: boolean, language = 'en') => ({ index, lastOfRun, language });

const PRIOR: PFirePrior = {
  level: {
    en: { a: 1.36, support: 773, contributors: 3 },
    [ANY_LANGUAGE]: { a: 1.33, support: 1077, contributors: 3 },
  },
  c: 1.84,
  cCI: [1.37, 2.54],
  b: -0.65,
  bCI: [-1.01, -0.47],
  compositionRange: [0.427, 0.537],
  fittedOn: { model: 'claude-opus-5', onTurns: 1077, offTurns: 2369, contributors: 3, dropped: 11 },
  binDisagreement: null,
};

test('a turn is priced from its own stratum first', () => {
  const c = curve(
    [0.9, 0.8, 0.7, 0.6, 0.5, 0.4],
    [0.3, 0.2, 0.1, 0.1, 0.1, 0.1],
    [0.6, 0.5, 0.4, 0.3, 0.2, 0.1],
  );
  assert.equal(pFireAt(c, turn(0, true)), 0.9);
  assert.equal(pFireAt(c, turn(0, false)), 0.3);
  assert.equal(pFireAt(c, turn(12, true)), 0.7, 'index 12 is the 10-20 bin');
});

test('a hole falls back to the pooled row for the SAME bin before moving in index', () => {
  const c = curve(
    [0.9, null, 0.7, 0.6, 0.5, 0.4],
    [0.3, 0.2, 0.1, 0.1, 0.1, 0.1],
    [0.6, 0.5, 0.4, 0.3, 0.2, 0.1],
  );
  assert.equal(pFireAt(c, turn(7, true)), 0.5, 'the 5-10 pooled row, not the 0-5 closing row');
});

test('with nothing at this depth it walks back through earlier bins, never forward', () => {
  const c = curve(
    [0.9, null, null, null, null, null],
    [0.3, null, null, null, null, null],
    [0.6, null, null, null, null, 0.05],
  );
  assert.equal(pFireAt(c, turn(50, true)), 0.9, 'the closest earlier measurement in the same stratum');
  assert.equal(pFireAt(c, turn(50, false)), 0.3);
});

test('a turn past the last bin edge is priced, not dropped', () => {
  const c = curve(
    [0.9, 0.8, 0.7, 0.6, 0.5, 0.4],
    [0.3, 0.2, 0.1, 0.1, 0.1, 0.1],
    [0.6, 0.5, 0.4, 0.3, 0.2, 0.1],
  );
  assert.equal(pFireAt(c, turn(5000, true)), 0.4);
  assert.equal(pFireAt(c, turn(5000, false)), 0.1);
});

test('an unusable curve with no prior says so, rather than answering 0 or 1 as if measured', () => {
  assert.equal(isUsable(NOTHING), false);
  assert.deepEqual(
    pFireWithSource(NOTHING, turn(0, true)),
    { p: 1, source: 'assumed' },
    'total by contract, and visibly the fallback',
  );

  const oneBin = curve(NONE, NONE, [null, 0.4, null, null, null, null]);
  assert.equal(isUsable(oneBin), true, 'one measured bin anywhere is a usable curve');
});

test('with nothing measured, the shipped prior prices the turn instead of assuming 1', () => {
  const at = pFireWithSource(NOTHING, turn(0, true), PRIOR);
  assert.equal(at.source, 'prior');
  assert.ok(at.p > 0.9 && at.p < 1, `a closing turn at index 0 should be high, got ${at.p}`);
  assert.ok(pFireWithSource(NOTHING, turn(0, false), PRIOR).p < at.p, 'mid-run sits below closing');
  assert.ok(pFireWithSource(NOTHING, turn(300, true), PRIOR).p < at.p, 'and it decays with depth');
});

test('a local measurement outranks the prior wherever one exists', () => {
  const measured = curve(
    [0.9, null, null, null, null, null],
    [0.3, null, null, null, null, null],
    [0.6, null, null, null, null, null],
  );
  assert.deepEqual(pFireWithSource(measured, turn(0, true), PRIOR), { p: 0.9, source: 'measured' });

  assert.deepEqual(pFireWithSource(measured, turn(300, true), PRIOR), { p: 0.9, source: 'measured' });
});

test('a prior with no levels cannot price anything and is not offered as one', () => {
  assert.equal(isUsablePrior({ ...PRIOR, level: {} }), false);
  assert.equal(isUsablePrior(null), false);
  assert.equal(isUsablePrior(PRIOR), true);
});
