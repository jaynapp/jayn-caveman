import type { ToolEffect } from '../types.js';

export const CAVEMAN: ToolEffect = {
  id: 'caveman',
  label: 'caveman',
  proseRatio: 0.83,
  source: 'benchmarked',
  n: 9,
};

export interface CavemanRatios {
  closing: number;
  midRun: number;
}

export const MID_RUN_IS_A_GUESS =
  'mid-run R is a pilot-informed placeholder, not a measurement: leave-one-out spans 0.31-1.42 ' +
  'and the underlying turns average 2-4 prose tokens';

export const CAVEMAN_RATIOS: CavemanRatios = {
  closing: 0.83,
  midRun: 0.86,
};

export interface RatioScenario {
  label: string;
  ratios: CavemanRatios;
  corner?: boolean;
}

function scale(closing: number, midRun: number): CavemanRatios {
  return { closing, midRun };
}

export const RATIO_SENSITIVITY: readonly RatioScenario[] = [
  { label: 'both 0.35 (the old assumption)', ratios: scale(0.35, 0.35) },
  { label: 'both 0.73 (measured IQR floor)', ratios: scale(0.73, 0.73) },
  { label: 'measured (closing 0.83)', ratios: CAVEMAN_RATIOS },
  { label: 'both 0.91 (measured IQR ceiling)', ratios: scale(0.91, 0.91) },
  { label: 'closing measured / mid-run 0.31', ratios: { ...CAVEMAN_RATIOS, midRun: 0.31 }, corner: true },
  { label: 'closing measured / mid-run 1.42', ratios: { ...CAVEMAN_RATIOS, midRun: 1.42 }, corner: true },
];
