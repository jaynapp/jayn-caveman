import { TOKENS_PER_WORD, type PFireCurve, type PFirePrior, type Sample } from './compliance.js';
import { pFireAt } from './pfire.js';

export function tokenWeightedPFire(
  samples: readonly Sample[],
  curve: PFireCurve,
  prior: PFirePrior | null = null,
): number | null {
  let weighted = 0;
  let weight = 0;
  for (const sample of samples) {
    if (!sample.cavemanActive) continue;
    weighted += sample.tokens * pFireAt(curve, sample, prior);
    weight += sample.tokens;
  }
  return weight === 0 ? null : weighted / weight;
}

export function tokenWeightedByPosition(
  samples: readonly Sample[],
  curve: PFireCurve,
  prior: PFirePrior | null = null,
): { closing: number | null; midRun: number | null } {
  const of = (lastOfRun: boolean) =>
    tokenWeightedPFire(
      samples.filter((s) => s.lastOfRun === lastOfRun),
      curve,
      prior,
    );
  return { closing: of(true), midRun: of(false) };
}

export type Fit = (subset: readonly Sample[]) => PFireCurve;

export interface Composition {
  omitted: string | null;

  language: string;

  share: number;
  meanPFire: number;
}

export function dominantLanguage(samples: readonly Sample[]): { language: string; share: number } {
  const byLanguage = new Map<string, number>();
  let total = 0;
  for (const sample of samples) {
    if (sample.language === 'unknown') continue;
    byLanguage.set(sample.language, (byLanguage.get(sample.language) ?? 0) + sample.tokens);
    total += sample.tokens;
  }
  const ranked = [...byLanguage].sort(([, a], [, b]) => b - a);
  const top = ranked[0];
  if (!top || total === 0) return { language: 'unknown', share: 0 };
  return { language: top[0], share: top[1] / total };
}

export function leaveOneCorpusOut(
  samples: readonly Sample[],
  groupOf: (sample: Sample) => string,
  fit: Fit,
  prior: PFirePrior | null = null,
): Composition[] {
  const byGroup = new Map<string, Sample[]>();
  for (const sample of samples) {
    const label = groupOf(sample);
    let group = byGroup.get(label);
    if (!group) byGroup.set(label, (group = []));
    group.push(sample);
  }
  if (byGroup.size < 2) return [];

  const rows: Composition[] = [];
  const all = tokenWeightedPFire(samples, fit(samples), prior);
  if (all !== null) {
    rows.push({
      omitted: null,
      language: dominantLanguage(samples).language,
      share: 1,
      meanPFire: all,
    });
  }

  const dropped: Composition[] = [];
  const onTokens = samples.reduce((sum, s) => sum + (s.cavemanActive ? s.tokens : 0), 0);
  for (const [label, group] of byGroup) {
    const kept = samples.filter((sample) => groupOf(sample) !== label);
    const mean = tokenWeightedPFire(kept, fit(kept), prior);
    if (mean === null) continue;
    const groupOn = group.reduce((sum, s) => sum + (s.cavemanActive ? s.tokens : 0), 0);
    dropped.push({
      omitted: label,
      language: dominantLanguage(group).language,
      share: onTokens === 0 ? 0 : groupOn / onTokens,
      meanPFire: mean,
    });
  }
  dropped.sort((a, b) => a.meanPFire - b.meanPFire);
  return [...rows, ...dropped];
}

export function asTokenBanded(samples: readonly Sample[]): Sample[] {
  return samples.map((sample) => ({ ...sample, words: sample.tokens / TOKENS_PER_WORD }));
}

export interface BandComparison {
  words: { closing: number | null; midRun: number | null };
  tokens: { closing: number | null; midRun: number | null };
}

export function bandDefinitionSweep(
  samples: readonly Sample[],
  fit: Fit,
  prior: PFirePrior | null = null,
): BandComparison {
  const rebanded = asTokenBanded(samples);
  return {
    words: tokenWeightedByPosition(samples, fit(samples), prior),
    tokens: tokenWeightedByPosition(rebanded, fit(rebanded), prior),
  };
}
