import { lastOfRunFlags, type SessionAnalysis, type Turn } from '../../../transcript/session.js';
import type { TokenCounter } from '../../../transcript/tokens.js';
import { styleOf, type Language } from '../style.js';

export const CELLS = ['closing-text', 'closing-tool', 'mid-run'] as const;
export type Cell = (typeof CELLS)[number];

export function cellOf(turn: { lastOfRun: boolean; hasToolUse: boolean }): Cell {
  if (!turn.lastOfRun) return 'mid-run';
  return turn.hasToolUse ? 'closing-tool' : 'closing-text';
}

export interface TrialTurn {
  index: number;
  cell: Cell;

  onlyTextBlocks: boolean;

  tokens: number;
  words: number;

  meanSentenceLength: number;

  structureShare: number;
  language: Language;
  model: string;

  scorable: boolean;
}

export async function trialTurns(session: SessionAnalysis, counter: TokenCounter): Promise<TrialTurn[]> {
  const lastOfRun = lastOfRunFlags(session.turns);
  const turns: TrialTurn[] = [];
  for (const [position, turn] of session.turns.entries()) {
    const style = styleOf(turn.proseText);
    turns.push({
      index: turn.index,
      cell: cellOf({ lastOfRun: lastOfRun[position]!, hasToolUse: turn.hasToolUse }),
      onlyTextBlocks: turn.onlyTextBlocks,
      tokens: turn.proseText.trim() ? await counter.count(turn.proseText, turn.model) : 0,
      words: style?.words ?? wordCountFloor(turn),
      meanSentenceLength: style?.meanSentenceLength ?? Number.NaN,
      structureShare: style?.structureShare ?? 0,
      language: style?.language ?? 'unknown',
      model: turn.model,
      scorable: style !== null,
    });
  }
  return turns;
}

function wordCountFloor(turn: Pick<Turn, 'proseText'>): number {
  const trimmed = turn.proseText.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export interface Pair {
  promptId: string;
  model: string;
  repeat: number;
  on: readonly TrialTurn[];
  off: readonly TrialTurn[];
}

export interface Ratio {
  pooled: number;

  median: number;

  iqr: readonly [number, number];
}

export interface CellEstimate {
  cell: Cell;

  mass: Ratio;

  perTurn: Ratio;

  pairs: number;

  dropped: number;
  onTokens: number;
  offTokens: number;

  onTurns: number;
  offTurns: number;

  onUnscorable: number;
  offUnscorable: number;
}

function inCell(turns: readonly TrialTurn[], cell: Cell): TrialTurn[] {
  return turns.filter((turn) => turn.cell === cell);
}

function sum(turns: readonly TrialTurn[], cell: Cell): number {
  return inCell(turns, cell).reduce((total, turn) => total + turn.tokens, 0);
}

function quantileOf(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return low === high ? sorted[low]! : sorted[low]! + (sorted[high]! - sorted[low]!) * (at - low);
}

function ratioOf(values: readonly number[], pooled: number): Ratio {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    pooled,
    median: quantileOf(sorted, 0.5),
    iqr: [quantileOf(sorted, 0.25), quantileOf(sorted, 0.75)],
  };
}

export function estimateCell(pairs: readonly Pair[], cell: Cell): CellEstimate {
  let onTokens = 0;
  let offTokens = 0;
  let onTurns = 0;
  let offTurns = 0;
  let dropped = 0;
  let onUnscorable = 0;
  let offUnscorable = 0;
  const massRatios: number[] = [];
  const perTurnRatios: number[] = [];

  for (const pair of pairs) {
    const onCell = inCell(pair.on, cell);
    const offCell = inCell(pair.off, cell);
    const on = sum(pair.on, cell);
    const off = sum(pair.off, cell);
    onUnscorable += onCell.filter((turn) => !turn.scorable).length;
    offUnscorable += offCell.filter((turn) => !turn.scorable).length;
    if (off === 0) {
      dropped++;
      continue;
    }
    onTokens += on;
    offTokens += off;
    onTurns += onCell.length;
    offTurns += offCell.length;
    massRatios.push(on / off);

    perTurnRatios.push(onCell.length === 0 ? 0 : on / onCell.length / (off / offCell.length));
  }

  return {
    cell,
    mass: ratioOf(massRatios, offTokens === 0 ? Number.NaN : onTokens / offTokens),
    perTurn: ratioOf(
      perTurnRatios,

      offTurns === 0 || offTokens === 0
        ? Number.NaN
        : (onTurns === 0 ? 0 : onTokens / onTurns) / (offTokens / offTurns),
    ),
    pairs: massRatios.length,
    dropped,
    onTokens,
    offTokens,
    onTurns,
    offTurns,
    onUnscorable,
    offUnscorable,
  };
}

export interface Sensitivity {
  cell: Cell;
  scorable: number;
  flagged: number;

  rate: number;

  unscorable: number;
}

export function sensitivityByCell(
  pairs: readonly Pair[],
  isFlagged: (turn: TrialTurn) => boolean | null,
): Sensitivity[] {
  return CELLS.map((cell) => {
    let scorable = 0;
    let flagged = 0;
    let unscorable = 0;
    for (const pair of pairs) {
      for (const turn of pair.on) {
        if (turn.cell !== cell) continue;
        if (!turn.scorable) {
          unscorable++;
          continue;
        }
        const verdict = isFlagged(turn);
        if (verdict === null) continue;
        scorable++;
        if (verdict) flagged++;
      }
    }
    return { cell, scorable, flagged, rate: scorable === 0 ? Number.NaN : flagged / scorable, unscorable };
  });
}
