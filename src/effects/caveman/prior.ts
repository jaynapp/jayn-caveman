import {
  ANY_LANGUAGE,
  ANY_MODEL,
  BAND_WEIGHT,
  binOf,
  cellPartsOf,
  expit,
  lookupFloor,
  modelFamily,
  type Floors,
  type PFireLevel,
  type PFirePrior,
  type Sample,
  type Thresholds,
} from './compliance.js';
import type { StyleBatch } from './observations.js';

export interface PriorRow {
  lang: string;
  band: number;
  shape: string;
  sentLen: number;
  index: number;
  last: boolean;

  model: string;
  caveman: boolean;

  group: string;

  run: number;
}

interface Point {
  terse: number;

  floor: number;

  level: number;
  last: number;
  logIndex: number;

  weight: number;

  run: number;

  contributor: string;
  language: string;
  bin: number;
}

export const MIN_LEVEL = 40;

const RESAMPLES = 200;

const PARAM_LIMIT = 25;

export function runsOf(rows: readonly { index: number }[], base = 0): number[] {
  const runs: number[] = [];
  let run = base - 1;
  let previous = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    if (row.index <= previous) run++;
    previous = row.index;
    runs.push(run);
  }
  return runs;
}

export function rowsFromBatches(batches: readonly StyleBatch[]): PriorRow[] {
  const rows: PriorRow[] = [];
  let base = 0;
  for (const batch of batches) {
    const runs = runsOf(batch.observations, base);
    for (const [position, observation] of batch.observations.entries()) {
      rows.push({
        lang: observation.lang,
        band: observation.band,
        shape: observation.shape,
        sentLen: observation.sentLen,
        index: observation.index,
        last: observation.last,
        model: modelFamily(observation.model),
        caveman: observation.caveman,
        group: batch.meta.contributor,
        run: runs[position]!,
      });
    }
    base = (runs[runs.length - 1] ?? base - 1) + 1;
  }
  return rows;
}

export function rowsFromSamples(samples: readonly Sample[], groupOf: (sample: Sample) => string): PriorRow[] {
  const runs = runsOf(samples);
  const rows: PriorRow[] = [];
  for (const [position, sample] of samples.entries()) {
    const parts = cellPartsOf(sample);
    if (parts === null || !Number.isFinite(sample.meanSentenceLength)) continue;
    rows.push({
      lang: parts.language,
      band: parts.band,
      shape: parts.shape,
      sentLen: sample.meanSentenceLength,
      index: sample.index,
      last: sample.lastOfRun,
      model: parts.model,
      caveman: sample.cavemanActive,
      group: groupOf(sample),
      run: runs[position]!,
    });
  }
  return rows;
}

export function dominantFamily(rows: readonly PriorRow[]): string | null {
  const tally = new Map<string, number>();
  for (const row of rows) {
    if (!row.caveman) continue;
    tally.set(row.model, (tally.get(row.model) ?? 0) + 1);
  }
  const ranked = [...tally.entries()].sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
  return ranked[0]?.[0] ?? null;
}

function cutoffFor(thresholds: Thresholds, row: PriorRow): number | undefined {
  const cell = `${row.lang}|${row.band}|${row.shape}`;
  return thresholds.cutoff.get(`${cell}|${row.model}`) ?? thresholds.cutoff.get(`${cell}|${ANY_MODEL}`);
}

function etaOf(point: Point, params: readonly number[], levels: number): number {
  return params[point.level]! + params[levels + 1]! * point.last + params[levels]! * point.logIndex;
}

function objective(
  points: readonly Point[],
  params: readonly number[],
  levels: number,
): { ll: number; gradient: number[] } {
  const gradient = new Array<number>(params.length).fill(0);
  let ll = 0;

  for (const point of points) {
    const p = expit(etaOf(point, params, levels));

    const probability = Math.min(1 - 1e-12, Math.max(1e-12, point.floor + (1 - point.floor) * p));
    ll += point.terse ? Math.log(probability) : Math.log(1 - probability);
    const dEta = point.terse ? ((1 - point.floor) * p * (1 - p)) / probability : -p;
    gradient[point.level]! += dEta;
    gradient[levels]! += dEta * point.logIndex;
    gradient[levels + 1]! += dEta * point.last;
  }
  return { ll, gradient };
}

function solve(matrix: number[][], vector: readonly number[]): number[] | null {
  const size = vector.length;
  const augmented = matrix.map((row, i) => [...row, vector[i]!]);
  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let row = column + 1; row < size; row++) {
      if (Math.abs(augmented[row]![column]!) > Math.abs(augmented[pivot]![column]!)) pivot = row;
    }
    if (Math.abs(augmented[pivot]![column]!) < 1e-12) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot]!, augmented[column]!];
    for (let row = 0; row < size; row++) {
      if (row === column) continue;
      const factor = augmented[row]![column]! / augmented[column]![column]!;
      for (let k = column; k <= size; k++) {
        augmented[row]![k] = augmented[row]![k]! - factor * augmented[column]![k]!;
      }
    }
  }
  return augmented.map((row, i) => row[size]! / row[i]!);
}

function maximise(points: readonly Point[], levels: number): number[] | null {
  const size = levels + 2;
  let params = new Array<number>(size).fill(0);
  let { ll, gradient } = objective(points, params, levels);

  for (let iteration = 0; iteration < 60; iteration++) {
    if (Math.max(...gradient.map(Math.abs)) < 1e-7) break;

    const step = 1e-4;
    const hessian: number[][] = [];
    for (let j = 0; j < size; j++) {
      const bumped = [...params];
      bumped[j] = bumped[j]! + step;
      const forward = objective(points, bumped, levels).gradient;
      hessian.push(forward.map((value, i) => (value - gradient[i]!) / step));
    }
    for (let i = 0; i < size; i++) {
      for (let j = i + 1; j < size; j++) {
        const mean = (hessian[i]![j]! + hessian[j]![i]!) / 2;
        hessian[i]![j] = mean;
        hessian[j]![i] = mean;
      }

      hessian[i]![i] = hessian[i]![i]! - 1e-6;
    }

    const direction = solve(hessian, gradient);
    if (direction === null) return null;

    let scale = 1;
    let accepted = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const candidate = params.map((value, i) => value - scale * direction[i]!);
      const next = objective(points, candidate, levels);
      if (next.ll > ll) {
        params = candidate;
        ll = next.ll;
        gradient = next.gradient;
        accepted = true;
        break;
      }
      scale /= 2;
    }
    if (!accepted) break;
  }

  return params.every((value) => Number.isFinite(value) && Math.abs(value) < PARAM_LIMIT) ? params : null;
}

function pooledLevel(points: readonly Point[], params: readonly number[], levels: number): number | null {
  const flat = points.map((point) => ({ ...point, level: 0 }));
  const at = (a: number): number =>
    objective(flat, [a, params[levels]!, params[levels + 1]!], 1).gradient[0]!;

  let lo = -PARAM_LIMIT;
  let hi = PARAM_LIMIT;

  if (at(lo) < 0 || at(hi) > 0) return null;
  for (let step = 0; step < 80; step++) {
    const guess = (lo + hi) / 2;
    if (at(guess) > 0) lo = guess;
    else hi = guess;
  }
  return (lo + hi) / 2;
}

function randomiser(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function percentile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]!;
}

function meanP(points: readonly Point[], params: readonly number[], levels: number): number | null {
  let weighted = 0;
  let weight = 0;
  for (const point of points) {
    weighted += point.weight * expit(etaOf(point, params, levels));
    weight += point.weight;
  }
  return weight === 0 ? null : weighted / weight;
}

function disagreement(
  points: readonly Point[],
  params: readonly number[],
  levels: number,
): PFirePrior['binDisagreement'] {
  const cells = new Map<string, Point[]>();
  for (const point of points) {
    const key = `${point.language}|${point.last ? 'last' : 'mid'}|${point.bin}`;
    let group = cells.get(key);
    if (group === undefined) cells.set(key, (group = []));
    group.push(point);
  }

  let worst: PFirePrior['binDisagreement'] = null;
  for (const [cell, group] of cells) {
    if (group.length < MIN_LEVEL) continue;
    const onRate = group.filter((point) => point.terse).length / group.length;
    const floor = group.reduce((total, point) => total + point.floor, 0) / group.length;
    if (!(floor < 1)) continue;
    const measured = Math.max(0, (onRate - floor) / (1 - floor));
    const formula =
      group.reduce((total, point) => total + expit(etaOf(point, params, levels)), 0) / group.length;
    const gap = Math.abs(measured - formula);
    if (worst === null || gap > worst.gap) worst = { cell, measured, formula, gap };
  }
  return worst;
}

function pointsOf(
  rows: readonly PriorRow[],
  thresholds: Thresholds,
  floors: Floors,
  model: string,
): { points: Point[]; dropped: number; offTurns: number } {
  const points: Point[] = [];
  let dropped = 0;
  let offTurns = 0;

  for (const row of rows) {
    if (row.model !== model) continue;
    if (!row.caveman) {
      offTurns++;
      continue;
    }
    const cutoff = cutoffFor(thresholds, row);
    const bin = binOf(row.index);
    const floor =
      bin < 0
        ? null
        : lookupFloor(floors, { bin, language: row.lang, lastOfRun: row.last, model: row.model });

    if (cutoff === undefined || floor === null || !(floor.rate < 1)) {
      dropped++;
      continue;
    }
    points.push({
      terse: row.sentLen < cutoff ? 1 : 0,
      floor: floor.rate,
      level: 0,
      last: row.last ? 1 : 0,
      logIndex: Math.log(1 + row.index),
      weight: BAND_WEIGHT[row.band] ?? 1,
      run: row.run,
      contributor: row.group,
      language: row.lang,
      bin,
    });
  }
  return { points, dropped, offTurns };
}

export function fitPrior(
  rows: readonly PriorRow[],
  thresholds: Thresholds,
  floors: Floors,
  family: string | null = null,
): PFirePrior | null {
  const model = family ?? dominantFamily(rows);
  if (model === null) return null;

  const { points, dropped, offTurns } = pointsOf(rows, thresholds, floors, model);
  if (points.length === 0) return null;

  const byLanguage = new Map<string, number>();
  for (const point of points) byLanguage.set(point.language, (byLanguage.get(point.language) ?? 0) + 1);
  const named = [...byLanguage.entries()]
    .filter(([, count]) => count >= MIN_LEVEL)
    .map(([language]) => language)
    .sort();
  const slotOf = new Map(named.map((language, index) => [language, index]));
  const leftovers = points.filter((point) => !slotOf.has(point.language));
  const levels = named.length + (leftovers.length > 0 ? 1 : 0);
  if (levels === 0) return null;
  for (const point of points) point.level = slotOf.get(point.language) ?? named.length;

  const fitted = maximise(points, levels);
  if (fitted === null) return null;
  const b = fitted[levels]!;
  const c = fitted[levels + 1]!;

  if (!points.some((point) => point.last) || !points.some((point) => !point.last)) return null;

  const pooled = pooledLevel(points, fitted, levels);
  if (pooled === null) return null;

  const contributors = new Set(points.map((point) => point.contributor));
  const level: Record<string, PFireLevel> = {};
  named.forEach((language, index) => {
    const own = points.filter((point) => point.language === language);
    level[language] = {
      a: fitted[index]!,
      support: own.length,
      contributors: new Set(own.map((point) => point.contributor)).size,
    };
  });
  level[ANY_LANGUAGE] = { a: pooled, support: points.length, contributors: contributors.size };

  const byRun = new Map<number, Point[]>();
  for (const point of points) {
    let group = byRun.get(point.run);
    if (group === undefined) byRun.set(point.run, (group = []));
    group.push(point);
  }
  const groups = [...byRun.values()];
  const random = randomiser(0x5eed);
  const bs: number[] = [];
  const cs: number[] = [];
  for (let draw = 0; draw < RESAMPLES; draw++) {
    const resampled: Point[] = [];
    for (let pick = 0; pick < groups.length; pick++) {
      resampled.push(...groups[Math.floor(random() * groups.length)]!);
    }
    const again = maximise(resampled, levels);
    if (again === null) continue;
    bs.push(again[levels]!);
    cs.push(again[levels + 1]!);
  }

  const composition: number[] = [];
  for (const omitted of contributors) {
    const kept = points.filter((point) => point.contributor !== omitted);
    if (kept.length === 0) continue;
    const refit = maximise(kept, levels);
    const mean = refit === null ? null : meanP(kept, refit, levels);
    if (mean !== null) composition.push(mean);
  }
  const centre = meanP(points, fitted, levels) ?? 0;

  return {
    level,
    c,
    cCI: cs.length > 1 ? [percentile(cs, 0.025), percentile(cs, 0.975)] : [c, c],
    b,
    bCI: bs.length > 1 ? [percentile(bs, 0.025), percentile(bs, 0.975)] : [b, b],
    compositionRange:
      composition.length > 0 ? [Math.min(...composition), Math.max(...composition)] : [centre, centre],
    fittedOn: { model, onTurns: points.length, offTurns, contributors: contributors.size, dropped },
    binDisagreement: disagreement(points, fitted, levels),
  };
}

export function summarisePrior(prior: PFirePrior): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    `  p_fire prior fitted on ${prior.fittedOn.model}: ${prior.fittedOn.onTurns} caveman-live turns ` +
      `from ${prior.fittedOn.contributors} contributor(s), against ${prior.fittedOn.offTurns} vanilla` +
      (prior.fittedOn.dropped > 0 ? ` (${prior.fittedOn.dropped} unscoreable or unfloored)` : ''),
    `    b ${prior.b.toFixed(3)} [${prior.bCI[0].toFixed(3)}, ${prior.bCI[1].toFixed(3)}]   ` +
      `c ${prior.c.toFixed(3)} [${prior.cCI[0].toFixed(3)}, ${prior.cCI[1].toFixed(3)}]`,
  ];
  for (const [language, entry] of Object.entries(prior.level)) {
    lines.push(
      `    a_${language.padEnd(2)} ${entry.a.toFixed(3).padStart(7)}   turn 0: ` +
        `${pct(expit(entry.a + prior.c))} closing / ${pct(expit(entry.a))} mid-run   ` +
        `n=${entry.support}, ${entry.contributors} contributor(s)` +
        (entry.contributors === 1 ? '   <- one person: level and person are the same number' : ''),
    );
  }
  lines.push(
    `    composition band ${pct(prior.compositionRange[0])}-${pct(prior.compositionRange[1])} ` +
      '(leave one contributor out, band-weighted)',
  );
  if (prior.binDisagreement) {
    const { cell, measured, formula, gap } = prior.binDisagreement;
    lines.push(
      `    worst bin-vs-formula gap ${pct(gap)} at ${cell} ` +
        `(measured ${pct(measured)}, formula ${pct(formula)})`,
    );
  }
  return lines.join('\n');
}
