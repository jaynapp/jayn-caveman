import type { TokenCounter } from '../../transcript/tokens.js';
import type { SessionAnalysis } from '../../transcript/session.js';
import {
  binOf,
  deserialiseThresholds,
  evaluatePrior,
  fitThresholds,
  floorsFrom,
  INDEX_BINS,
  mergeThresholds,
  modelFamily,
  pFireByIndex,
  TERSE_QUANTILE,
  cellCompatibility,
  type MergedThresholds,
  type PFireCurve,
  type PFirePrior,
  type Sample,
} from './compliance.js';
import { collectSamples } from './samples.js';
import { readThresholdFile, thresholdPathFor } from './thresholds.js';

export interface PFireModel {
  curve: PFireCurve;
  thresholds: MergedThresholds;

  samples: Sample[];

  prior: PFirePrior | null;

  registryRejected: string | null;

  borrowedCells: number;
}

export type PFireSource = 'measured' | 'prior' | 'assumed';

export interface TurnPosition {
  index: number;
  lastOfRun: boolean;

  language: string;
}

export function pFireWithSource(
  curve: PFireCurve,
  turn: TurnPosition,
  prior: PFirePrior | null = null,
): { p: number; source: PFireSource } {
  const rows = turn.lastOfRun ? curve.byPosition.closing : curve.byPosition.midRun;

  const bin = binOf(turn.index) >= 0 ? binOf(turn.index) : INDEX_BINS.length - 1;

  const own = rows[bin]?.pFire;
  if (own != null) return { p: own, source: 'measured' };
  const pooled = curve.pooled[bin]?.pFire;
  if (pooled != null) return { p: pooled, source: 'measured' };
  for (let earlier = bin - 1; earlier >= 0; earlier--) {
    const value = rows[earlier]?.pFire ?? curve.pooled[earlier]?.pFire;
    if (value != null) return { p: value, source: 'measured' };
  }
  if (prior !== null) return { p: evaluatePrior(prior, turn), source: 'prior' };

  return { p: 1, source: 'assumed' };
}

export function pFireAt(curve: PFireCurve, turn: TurnPosition, prior: PFirePrior | null = null): number {
  return pFireWithSource(curve, turn, prior).p;
}

export function isUsable(curve: PFireCurve): boolean {
  return curve.pooled.some((bin) => bin.pFire !== null);
}

export function isUsablePrior(prior: PFirePrior | null): prior is PFirePrior {
  return prior !== null && Object.keys(prior.level).length > 0;
}

export interface PFireOptions {
  quantileAt?: number;
  registryPath?: string;

  model?: string;
}

export async function loadPFireModel(
  sessions: readonly SessionAnalysis[],
  counter: TokenCounter,
  { quantileAt = TERSE_QUANTILE, registryPath, model }: PFireOptions = {},
): Promise<PFireModel> {
  const collected = await collectSamples(sessions, counter);
  const samples =
    model === undefined
      ? collected
      : collected.filter((sample) => modelFamily(sample.model) === modelFamily(model));
  const path = registryPath ?? thresholdPathFor(quantileAt, TERSE_QUANTILE);
  const file = await readThresholdFile(path);

  const rejected =
    file === null
      ? null
      : file.quantile !== quantileAt
        ? `fitted at quantile ${file.quantile}, not ${quantileAt}`
        : cellCompatibility(file).reason;

  const usableFile = file !== null && rejected === null ? file : null;
  const thresholds = mergeThresholds(
    fitThresholds(samples, quantileAt),
    usableFile ? deserialiseThresholds(usableFile) : null,
  );
  const curve = pFireByIndex(samples, thresholds, floorsFrom(usableFile?.floors));
  const prior = usableFile?.pFire ?? null;

  return {
    curve,
    thresholds,
    samples,
    prior: isUsablePrior(prior) ? prior : null,
    registryRejected: rejected,
    borrowedCells: [...curve.byPosition.closing, ...curve.byPosition.midRun].filter(
      (bin) => bin.method === 'shifted',
    ).length,
  };
}
