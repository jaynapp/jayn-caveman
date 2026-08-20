import type { ToolEffect } from '../types.js';

export const CAVEMAN: ToolEffect = {
  id: 'caveman',
  label: 'caveman',
  proseRatio: 0.71,
  source: 'benchmarked',
  n: 15,
};

export type RatioLanguage = 'en' | 'fr' | 'unknown';

export interface CavemanRatios {
  closing: Record<RatioLanguage, number>;

  midRun: number;
}

export const CAVEMAN_RATIOS: CavemanRatios = {
  closing: { en: 0.83, fr: 0.54, unknown: 0.71 },
  midRun: 0.56,
};

export function closingRatio(ratios: CavemanRatios, language: string): number {
  return ratios.closing[language as RatioLanguage] ?? ratios.closing.unknown;
}

export interface RatioScenario {
  label: string;
  ratios: CavemanRatios;

  corner?: boolean;
}

function scale(closing: number, midRun: number): CavemanRatios {
  return { closing: { en: closing, fr: closing, unknown: closing }, midRun };
}

export const RATIO_SENSITIVITY: readonly RatioScenario[] = [
  { label: 'both 0.35 (the old assumption)', ratios: scale(0.35, 0.35) },
  { label: 'both 0.54 (measured floor, fr)', ratios: scale(0.54, 0.54) },
  { label: 'measured per language', ratios: CAVEMAN_RATIOS },
  { label: 'both 0.91 (measured ceiling, en)', ratios: scale(0.91, 0.91) },
  { label: 'closing measured / mid-run 0.12', ratios: { ...CAVEMAN_RATIOS, midRun: 0.12 }, corner: true },
  { label: 'closing measured / mid-run 1.20', ratios: { ...CAVEMAN_RATIOS, midRun: 1.2 }, corner: true },
];
