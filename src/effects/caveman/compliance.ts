import type { Language, Style } from './style.js';

export interface Sample extends Style {
  tokens: number;

  index: number;

  lastOfRun: boolean;

  model: string;

  cavemanActive: boolean;
}

export const BANDS: readonly (readonly [number, number])[] = [
  [7, 17],
  [17, 34],
  [34, 67],
  [67, 135],
  [135, 539],
  [539, Number.POSITIVE_INFINITY],
];

export const TOKENS_PER_WORD = 2.968;

export const BAND_WEIGHT: readonly number[] = BANDS.map(([lo, hi]) =>
  Number.isFinite(hi) ? (lo + hi) / 2 : lo * 2,
);

const STRUCTURE_SPLIT = 0.2;

export type Cell = string;

export const LANGUAGES = ['en', 'fr'] as const;
export const SHAPES = ['prose', 'list'] as const;

export function modelFamily(model: string): string {
  return model.replace(/-\d{8}$/, '') || 'unknown';
}

export const ANY_MODEL = '*';

export interface CellParts {
  language: (typeof LANGUAGES)[number];
  band: number;
  shape: (typeof SHAPES)[number];

  model: string;
}

type Placeable = Pick<Sample, 'language' | 'words' | 'structureShare' | 'model'>;

export function cellPartsOf(sample: Placeable): CellParts | null {
  const band = BANDS.findIndex(([lo, hi]) => sample.words >= lo && sample.words < hi);
  if (band < 0 || sample.language === 'unknown') return null;
  return {
    language: sample.language,
    band,
    shape: sample.structureShare >= STRUCTURE_SPLIT ? 'list' : 'prose',
    model: modelFamily(sample.model),
  };
}

export function cellKeyOf(parts: Omit<CellParts, 'model'> & { model: string }): Cell {
  return `${parts.language}|${parts.band}|${parts.shape}|${parts.model}`;
}

export function cellOf(sample: Placeable): Cell | null {
  const parts = cellPartsOf(sample);
  return parts === null ? null : cellKeyOf(parts);
}

export function rollupCellOf(sample: Placeable): Cell | null {
  const parts = cellPartsOf(sample);
  return parts === null ? null : cellKeyOf({ ...parts, model: ANY_MODEL });
}

export const MIN_CELL = 20;

export const TERSE_QUANTILE = 0.25;

export function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

export interface Thresholds {
  cutoff: ReadonlyMap<Cell, number>;

  support: ReadonlyMap<Cell, number>;
}

export function fitThresholds(samples: readonly Sample[], quantileAt: number = TERSE_QUANTILE): Thresholds {
  const grouped = new Map<Cell, number[]>();
  for (const sample of samples) {
    if (sample.cavemanActive || !Number.isFinite(sample.meanSentenceLength)) continue;
    for (const cell of [cellOf(sample), rollupCellOf(sample)]) {
      if (!cell) continue;
      let list = grouped.get(cell);
      if (list === undefined) grouped.set(cell, (list = []));
      list.push(sample.meanSentenceLength);
    }
  }

  const cutoff = new Map<Cell, number>();
  const support = new Map<Cell, number>();
  for (const [cell, lengths] of grouped) {
    if (lengths.length < MIN_CELL) continue;
    cutoff.set(cell, quantile(lengths, quantileAt));
    support.set(cell, lengths.length);
  }
  return { cutoff, support };
}

export interface CutoffHit {
  cutoff: number;
  support: number;

  exact: boolean;
}

export function lookupCutoff(thresholds: Thresholds, sample: Placeable): CutoffHit | null {
  const parts = cellPartsOf(sample);
  if (parts === null) return null;
  const own = thresholds.cutoff.get(cellKeyOf(parts));
  if (own !== undefined) {
    return { cutoff: own, support: thresholds.support.get(cellKeyOf(parts)) ?? 0, exact: true };
  }
  const rollup = cellKeyOf({ ...parts, model: ANY_MODEL });
  const rolled = thresholds.cutoff.get(rollup);
  if (rolled === undefined) return null;
  return { cutoff: rolled, support: thresholds.support.get(rollup) ?? 0, exact: false };
}

export interface CorpusCredit {
  id: string;
  vanillaTurns: number;
}

export interface CellCoverage {
  cell: Cell;
  language: string;
  band: readonly [number, number];
  shape: string;

  model: string;

  vanilla: number;

  blocked: number;
  fitted: boolean;

  needed: number;
}

export function cellCoverage(samples: readonly Sample[], thresholds: Thresholds): CellCoverage[] {
  const tally = new Map<Cell, { vanilla: number; blocked: number }>();
  const families = new Set<string>();
  for (const sample of samples) {
    if (!Number.isFinite(sample.meanSentenceLength)) continue;
    const parts = cellPartsOf(sample);
    if (parts === null) continue;
    families.add(parts.model);

    for (const cell of [cellKeyOf(parts), cellKeyOf({ ...parts, model: ANY_MODEL })]) {
      const entry = tally.get(cell) ?? { vanilla: 0, blocked: 0 };
      if (sample.cavemanActive) entry.blocked++;
      else entry.vanilla++;
      tally.set(cell, entry);
    }
  }

  const rows: CellCoverage[] = [];
  for (const model of [...families].sort().concat(ANY_MODEL)) {
    for (const language of LANGUAGES) {
      BANDS.forEach((band, index) => {
        for (const shape of SHAPES) {
          const cell = cellKeyOf({ language, band: index, shape, model });
          const rollup = cellKeyOf({ language, band: index, shape, model: ANY_MODEL });
          const entry = tally.get(cell) ?? { vanilla: 0, blocked: 0 };
          const fitted = thresholds.cutoff.has(cell);
          const rescued = fitted || thresholds.cutoff.has(rollup);
          rows.push({
            cell,
            language,
            band,
            shape,
            model,
            vanilla: entry.vanilla,
            blocked: rescued ? 0 : entry.blocked,
            fitted,
            needed: fitted ? 0 : Math.max(0, MIN_CELL - entry.vanilla),
          });
        }
      });
    }
  }
  return rows;
}

export interface ArmShare {
  model: string;
  on: number;
  off: number;
  onShare: number;
  offShare: number;

  gap: number;
}

export interface ArmBalance {
  rows: ArmShare[];
  onTurns: number;
  offTurns: number;

  worst: number;
  imbalanced: boolean;
}

export const ARM_IMBALANCE = 0.2;

export function armBalance(samples: readonly Sample[]): ArmBalance {
  const tally = new Map<string, { on: number; off: number }>();
  let onTurns = 0;
  let offTurns = 0;
  for (const sample of samples) {
    const family = modelFamily(sample.model);
    const entry = tally.get(family) ?? { on: 0, off: 0 };
    if (sample.cavemanActive) {
      entry.on++;
      onTurns++;
    } else {
      entry.off++;
      offTurns++;
    }
    tally.set(family, entry);
  }

  const rows = [...tally.entries()]
    .map(([model, { on, off }]) => {
      const onShare = onTurns === 0 ? 0 : on / onTurns;
      const offShare = offTurns === 0 ? 0 : off / offTurns;
      return { model, on, off, onShare, offShare, gap: onShare - offShare };
    })
    .sort((a, b) => b.on - a.on || b.off - a.off);

  const comparable = onTurns > 0 && offTurns > 0;
  const worst = comparable ? Math.max(0, ...rows.map((row) => Math.abs(row.gap))) : 0;
  return { rows, onTurns, offTurns, worst, imbalanced: comparable && worst > ARM_IMBALANCE };
}

export const CELL_VERSION = 4;

export interface FloorEntry {
  bin: number;
  from: number;
  to: number | null;
  language: string;
  position: 'last' | 'mid';
  model: string;
  rate: number;
  support: number;
}

export const logit = (p: number): number => Math.log(p / (1 - p));
export const expit = (x: number): number => 1 / (1 + Math.exp(-x));

export interface PFireLevel {
  a: number;

  support: number;

  contributors: number;
}

export interface PFirePrior {
  level: Record<string, PFireLevel>;

  c: number;
  cCI: [number, number];

  b: number;
  bCI: [number, number];

  compositionRange: [number, number];

  fittedOn: {
    model: string;
    onTurns: number;
    offTurns: number;
    contributors: number;

    dropped: number;
  };

  binDisagreement: { cell: string; measured: number; formula: number; gap: number } | null;
}

export const ANY_LANGUAGE = '*';

export function evaluatePrior(
  prior: PFirePrior,
  turn: { language: string; lastOfRun: boolean; index: number },
): number {
  const level = prior.level[turn.language] ?? prior.level[ANY_LANGUAGE];

  if (level === undefined) return 1;
  return expit(level.a + prior.c * (turn.lastOfRun ? 1 : 0) + prior.b * Math.log(1 + turn.index));
}

export interface ThresholdFile {
  cellVersion?: number;
  fittedAt: string;

  corpora: CorpusCredit[];
  quantile: number;
  cells: Record<Cell, { cutoff: number; support: number }>;

  floors: FloorEntry[];

  pFire?: PFirePrior;
}

export function creditCorpora(vanillaTurnsByCorpus: ReadonlyMap<string, number>): CorpusCredit[] {
  return [...vanillaTurnsByCorpus.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, vanillaTurns], index) => ({ id: `corpus-${String.fromCharCode(97 + index)}`, vanillaTurns }));
}

export function serialiseThresholds(
  thresholds: Thresholds,
  corpora: CorpusCredit[],
  floors: readonly FloorEntry[],
  quantileAt: number = TERSE_QUANTILE,
  pFire: PFirePrior | null = null,
): ThresholdFile {
  const cells: ThresholdFile['cells'] = {};
  for (const [cell, cutoff] of [...thresholds.cutoff].sort(([a], [b]) => a.localeCompare(b))) {
    cells[cell] = { cutoff, support: thresholds.support.get(cell) ?? 0 };
  }
  return {
    cellVersion: CELL_VERSION,
    fittedAt: new Date().toISOString(),
    corpora,
    quantile: quantileAt,
    cells,
    floors: [...floors].sort(
      (a, b) =>
        a.bin - b.bin ||
        a.language.localeCompare(b.language) ||
        a.position.localeCompare(b.position) ||
        a.model.localeCompare(b.model),
    ),
    ...(pFire === null ? {} : { pFire }),
  };
}

export function deserialiseThresholds(file: ThresholdFile): Thresholds {
  const cutoff = new Map<Cell, number>();
  const support = new Map<Cell, number>();
  for (const [cell, entry] of Object.entries(file.cells)) {
    cutoff.set(cell, entry.cutoff);
    support.set(cell, entry.support);
  }
  return { cutoff, support };
}

export function cellCompatibility(file: ThresholdFile): { ok: boolean; reason: string | null } {
  const version = file.cellVersion ?? 1;
  if (version === CELL_VERSION) return { ok: true, reason: null };
  const known: Record<number, string> = {
    1: 'fitted with token size-bands and index-only floors (cell version 1); this build bands on words',
    2: 'fitted with cutoffs pooled across model families (cell version 2); this build keys them on model',
    3: 'fitted with turns 0-5 and 5-10 as separate index bins (cell version 3); this build merges them into 0-10, so its per-bin floors are keyed to edges that no longer exist',
  };
  return {
    ok: false,
    reason: known[version] ?? `fitted for cell version ${version}, this build reads ${CELL_VERSION}`,
  };
}

export type Floors = ReadonlyMap<string, { rate: number; support: number }>;

export function floorKey(bin: number, language: string, lastOfRun: boolean, model: string): string {
  return `${bin}|${language}|${lastOfRun ? 'last' : 'mid'}|${model}`;
}

export function binOf(index: number): number {
  return INDEX_BINS.findIndex(([from, to]) => index >= from && index < to);
}

export function floorsFrom(entries: readonly FloorEntry[] | null | undefined): Floors {
  const floors = new Map<string, { rate: number; support: number }>();
  for (const entry of entries ?? []) {
    floors.set(floorKey(entry.bin, entry.language, entry.position === 'last', entry.model), {
      rate: entry.rate,
      support: entry.support,
    });
  }
  return floors;
}

export interface FloorHit {
  rate: number;
  support: number;

  exact: boolean;
}

export function lookupFloor(
  floors: Floors,
  where: { bin: number; language: string; lastOfRun: boolean; model: string },
): FloorHit | null {
  const family = modelFamily(where.model);
  const exact = floors.get(floorKey(where.bin, where.language, where.lastOfRun, family));
  if (exact) return { ...exact, exact: true };
  const rolled = floors.get(floorKey(where.bin, where.language, where.lastOfRun, ANY_MODEL));
  return rolled ? { ...rolled, exact: false } : null;
}

export function fitFloors(samples: readonly Sample[], thresholds: Thresholds): FloorEntry[] {
  type Tally = {
    bin: number;
    language: string;
    lastOfRun: boolean;
    model: string;
    terse: number;
    total: number;
  };
  const tally = new Map<string, Tally>();
  const add = (parts: Omit<Tally, 'terse' | 'total'>, terse: boolean) => {
    const key = floorKey(parts.bin, parts.language, parts.lastOfRun, parts.model);
    const entry = tally.get(key) ?? { ...parts, terse: 0, total: 0 };
    entry.total++;
    if (terse) entry.terse++;
    tally.set(key, entry);
  };

  for (const sample of samples) {
    if (sample.cavemanActive || sample.language === 'unknown') continue;
    const terse = isTerse(sample, thresholds);
    if (terse === null) continue;
    const bin = binOf(sample.index);
    if (bin < 0) continue;
    const where = { bin, language: sample.language, lastOfRun: sample.lastOfRun };
    add({ ...where, model: modelFamily(sample.model) }, terse);
    add({ ...where, model: ANY_MODEL }, terse);
  }

  const entries: FloorEntry[] = [];
  for (const entry of tally.values()) {
    if (entry.total < MIN_OFF) continue;
    const [from, to] = INDEX_BINS[entry.bin]!;
    entries.push({
      bin: entry.bin,
      from,
      to: Number.isFinite(to) ? to : null,
      language: entry.language,
      position: entry.lastOfRun ? 'last' : 'mid',
      model: entry.model,
      rate: entry.terse / entry.total,
      support: entry.total,
    });
  }
  return entries;
}

export interface MergedThresholds extends Thresholds {
  origin: ReadonlyMap<Cell, 'local' | 'shipped'>;
}

export function mergeThresholds(local: Thresholds, shipped: Thresholds | null): MergedThresholds {
  const cutoff = new Map(local.cutoff);
  const support = new Map(local.support);
  const origin = new Map<Cell, 'local' | 'shipped'>();
  for (const cell of local.cutoff.keys()) origin.set(cell, 'local');

  for (const [cell, value] of shipped?.cutoff ?? []) {
    if (cutoff.has(cell)) continue;
    cutoff.set(cell, value);
    support.set(cell, shipped!.support.get(cell) ?? 0);
    origin.set(cell, 'shipped');
  }
  return { cutoff, support, origin };
}

export interface TerseHit {
  terse: boolean;
  exact: boolean;
}

export function terseness(sample: Sample, thresholds: Thresholds): TerseHit | null {
  if (!Number.isFinite(sample.meanSentenceLength)) return null;
  const hit = lookupCutoff(thresholds, sample);
  return hit === null ? null : { terse: sample.meanSentenceLength < hit.cutoff, exact: hit.exact };
}

export function isTerse(sample: Sample, thresholds: Thresholds): boolean | null {
  return terseness(sample, thresholds)?.terse ?? null;
}

export interface Coverage {
  scored: number;

  unscored: number;

  noThreshold: number;

  noSentence: number;

  borrowedCutoffs: number;
}

export function coverageOf(samples: readonly Sample[], thresholds: Thresholds): Coverage {
  let scored = 0;
  let noThreshold = 0;
  let noSentence = 0;
  let borrowedCutoffs = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample.meanSentenceLength)) noSentence++;
    else {
      const hit = terseness(sample, thresholds);
      if (hit === null) noThreshold++;
      else {
        scored++;
        if (!hit.exact) borrowedCutoffs++;
      }
    }
  }
  return { scored, unscored: noThreshold + noSentence, noThreshold, noSentence, borrowedCutoffs };
}

export interface Bin {
  from: number;
  to: number;

  onTurns: number;

  offTurns: number;

  onRate: number;

  offRate: number;

  floorOrigin: 'local' | 'shipped' | 'mixed' | 'none';

  floorFallbacks: number;

  unfloored: number;

  closingShare: number;

  pFire: number | null;

  method: 'measured' | 'shifted' | 'none';
}

export interface PFireCurve {
  byPosition: Record<'closing' | 'midRun', Bin[]>;

  pooled: Bin[];
}

export const C_LAST = 1.814;

export function shiftedPair(
  pooled: number,
  closingShare: number,
  c: number = C_LAST,
): { closing: number; midRun: number } {
  if (!(pooled > 0)) return { closing: 0, midRun: 0 };
  if (pooled >= 1) return { closing: 1, midRun: 1 };

  if (!(closingShare > 0)) return { closing: expit(logit(pooled) + c), midRun: pooled };
  if (closingShare >= 1) return { closing: pooled, midRun: expit(logit(pooled) - c) };

  let lo = -50;
  let hi = 50;
  for (let step = 0; step < 60; step++) {
    const guess = (lo + hi) / 2;
    const mix = closingShare * expit(guess + c) + (1 - closingShare) * expit(guess);
    if (mix < pooled) lo = guess;
    else hi = guess;
  }
  const midRun = expit((lo + hi) / 2);
  return { closing: expit(logit(midRun) + c), midRun };
}

export const INDEX_BINS: readonly (readonly [number, number])[] = [
  [0, 10],
  [10, 20],
  [20, 40],
  [40, 80],
  [80, Number.POSITIVE_INFINITY],
];

const MIN_ON = 8;
const MIN_OFF = 10;

function correct(onRate: number, offRate: number): number | null {
  if (!(offRate < 1)) return null;
  return Math.max(0, (onRate - offRate) / (1 - offRate));
}

export function pFireByIndex(
  samples: readonly Sample[],
  thresholds: Thresholds,
  shippedFloors: Floors = new Map(),
  c: number = C_LAST,
): PFireCurve {
  const localFloors = floorsFrom(fitFloors(samples, thresholds));

  const scored = samples
    .map((sample) => ({ sample, terse: isTerse(sample, thresholds) }))
    .filter((entry): entry is { sample: Sample; terse: boolean } => entry.terse !== null);

  type Scored = (typeof scored)[number];

  const chargeFloor = (
    bin: number,
    { sample }: Scored,
  ): (FloorHit & { origin: 'local' | 'shipped' }) | null => {
    const where = { bin, language: sample.language, lastOfRun: sample.lastOfRun, model: sample.model };
    const local = lookupFloor(localFloors, where);
    if (local) return { ...local, origin: 'local' };
    const shipped = lookupFloor(shippedFloors, where);
    return shipped ? { ...shipped, origin: 'shipped' } : null;
  };

  const measure = (bin: number, on: Scored[], off: Scored[], closingShare: number): Bin => {
    const [from, to] = INDEX_BINS[bin]!;

    const priced = on
      .map((entry) => ({ entry, floor: chargeFloor(bin, entry) }))
      .filter(
        (row): row is { entry: Scored; floor: FloorHit & { origin: 'local' | 'shipped' } } =>
          row.floor !== null,
      );

    const origins = new Set(priced.map((row) => row.floor.origin));
    const onRate = priced.length
      ? priced.filter((row) => row.entry.terse).length / priced.length
      : Number.NaN;
    const offRate = priced.length
      ? priced.reduce((total, row) => total + row.floor.rate, 0) / priced.length
      : Number.NaN;

    return {
      from,
      to,
      onTurns: priced.length,
      offTurns: off.length,
      onRate,
      offRate,
      floorOrigin: origins.size === 0 ? 'none' : origins.size > 1 ? 'mixed' : [...origins][0]!,
      floorFallbacks: priced.filter((row) => !row.floor.exact).length,
      unfloored: on.length - priced.length,
      closingShare,
      pFire: priced.length >= MIN_ON && Number.isFinite(offRate) ? correct(onRate, offRate) : null,
      method: priced.length >= MIN_ON && Number.isFinite(offRate) ? 'measured' : 'none',
    };
  };

  const pooled: Bin[] = [];
  const closing: Bin[] = [];
  const midRun: Bin[] = [];

  INDEX_BINS.forEach(([from, to], bin) => {
    const inBin = scored.filter((e) => e.sample.index >= from && e.sample.index < to);
    const on = inBin.filter((e) => e.sample.cavemanActive);
    const off = inBin.filter((e) => !e.sample.cavemanActive);
    const closingShare = on.length ? on.filter((e) => e.sample.lastOfRun).length / on.length : Number.NaN;

    const both = measure(bin, on, off, closingShare);
    const rows = {
      closing: measure(
        bin,
        on.filter((e) => e.sample.lastOfRun),
        off.filter((e) => e.sample.lastOfRun),
        closingShare,
      ),
      midRun: measure(
        bin,
        on.filter((e) => !e.sample.lastOfRun),
        off.filter((e) => !e.sample.lastOfRun),
        closingShare,
      ),
    };

    if (both.pFire !== null && (rows.closing.pFire === null || rows.midRun.pFire === null)) {
      const split = shiftedPair(both.pFire, Number.isFinite(closingShare) ? closingShare : 0, c);
      if (rows.closing.pFire === null)
        rows.closing = { ...rows.closing, pFire: split.closing, method: 'shifted' };
      if (rows.midRun.pFire === null)
        rows.midRun = { ...rows.midRun, pFire: split.midRun, method: 'shifted' };
    }

    pooled.push(both);
    closing.push(rows.closing);
    midRun.push(rows.midRun);
  });

  return { byPosition: { closing, midRun }, pooled };
}

export interface GroupResult {
  label: string;
  language: Language;
  onTurns: number;

  curve: PFireCurve;
}

export function pFireByGroup(
  samples: readonly Sample[],
  thresholds: Thresholds,
  groupOf: (sample: Sample) => string,
  shippedFloors: Floors = new Map(),
  c: number = C_LAST,
): GroupResult[] {
  const vanilla = samples.filter((s) => !s.cavemanActive);
  const groups = new Map<string, Sample[]>();
  for (const sample of samples) {
    if (!sample.cavemanActive || sample.language === 'unknown') continue;
    const key = `${groupOf(sample)}|${sample.language}`;
    let members = groups.get(key);
    if (members === undefined) groups.set(key, (members = []));
    members.push(sample);
  }

  return [...groups.entries()]
    .map(([key, on]) => {
      const language = on[0]!.language;

      const control = vanilla.filter((s) => s.language === language);
      return {
        label: key.slice(0, key.lastIndexOf('|')),
        language,
        onTurns: on.length,
        curve: pFireByIndex([...on, ...control], thresholds, shippedFloors, c),
      };
    })
    .sort((a, b) => b.onTurns - a.onTurns);
}
