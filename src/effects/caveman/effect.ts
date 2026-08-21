import type { ToolEffect } from '../types.js';

export const CAVEMAN: ToolEffect = {
  id: 'caveman',
  label: 'caveman',
  proseRatio: 0.689,
  source: 'benchmarked',
  n: 45,
};

export interface CavemanRatios {
  closing: number;
  midRun: number;
}

/**
 * Both strata are measured, in one interactive paired trial: 45 ON/OFF pairs over 90 real
 * coding sessions, two operators, same prompt pasted into each arm against the same pinned
 * repository state. English only.
 *
 * Re-derive with:
 *   jayn-caveman trial analyze --root <ledger>,<ledger>
 *
 * closing  0.689 token-mass, pair IQR [0.59, 0.77], 39178/56885 prose tokens over 45/45 turns.
 * mid-run  0.383 token-mass, pair IQR [0.15, 0.93], 961/2512 prose tokens over 254/325 turns.
 *
 * mid-run is the token-mass ratio, not the 0.490 per-turn one, because bills are paid in
 * tokens. It includes silent turns on purpose: caveman produced no prose at all on 206 of 254
 * mid-run turns against 232 of 325 in control, and silence is a treatment outcome rather than
 * a turn to drop.
 */
export const CAVEMAN_RATIOS: CavemanRatios = {
  closing: 0.689,
  midRun: 0.383,
};

/** The per-turn mid-run ratio, reported beside the token-mass one but not priced with it. */
export const MID_RUN_PER_TURN = 0.49;

export interface RatioScenario {
  label: string;
  ratios: CavemanRatios;
  corner?: boolean;
}

function scale(closing: number, midRun: number): CavemanRatios {
  return { closing, midRun };
}

/**
 * Every scenario carries TWO ratios, because the trial measured two strata and they are far
 * apart. Collapsing them to one number is the error the band exists to expose.
 *
 * The bottom row is caveman's own advertised 0.35, charged to both strata — not a stale guess
 * of ours but the figure the tool is published with and the one every benchmark of it has
 * used. It saves MORE than either pair quartile, and that is the point: the quartiles leave
 * closing turns at 0.59-0.77 where the trial found them, and closing turns carry 78% of the
 * prose, so most of the advertised saving is a claim about the stratum that holds the money.
 */
export const RATIO_SENSITIVITY: readonly RatioScenario[] = [
  { label: "caveman's advertised 0.35 (both strata)", ratios: scale(0.35, 0.35) },
  { label: 'lower pair quartile (closing 0.59 / mid-run 0.15)', ratios: scale(0.59, 0.15) },
  { label: 'pooled interactive trial', ratios: CAVEMAN_RATIOS },
  { label: 'upper pair quartile (closing 0.77 / mid-run 0.93)', ratios: scale(0.77, 0.93) },
];
