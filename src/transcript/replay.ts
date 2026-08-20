import { price } from '../billing/pricing.js';
import type { SessionAnalysis, Turn } from './session.js';
import type { InjectionProfile } from './injection.js';

const M = 1_000_000;
const ZERO = {
  inputTokens: 0,
  outputTokens: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
};

interface Rates {
  input: number;

  output: number;

  write5m: number;
  write1h: number;
  read: number;
}

function ratesFor(model: string, timestamp: Date): Rates | null {
  const per = (tokens: Partial<typeof ZERO>) => price(model, timestamp, { ...ZERO, ...tokens }).costUSD;
  const input = per({ inputTokens: M });
  const output = per({ outputTokens: M });
  if (input == null || output == null || input === 0) return null;
  return {
    input: input / M,
    output: output / M,
    write5m: per({ cacheWrite5m: M })! / input,
    write1h: per({ cacheWrite1h: M })! / input,
    read: per({ cacheRead: M })! / input,
  };
}

function writeMultiplier(turn: Turn, rates: Rates): number {
  const total = turn.cacheWrite5m + turn.cacheWrite1h;
  if (total === 0) return rates.write5m;
  return (rates.write5m * turn.cacheWrite5m + rates.write1h * turn.cacheWrite1h) / total;
}

function isColdStart(turn: Turn): boolean {
  return turn.cacheRead === 0 && turn.cacheWrite5m + turn.cacheWrite1h > 0;
}

export interface CostBreakdown {
  costUSD: number;
  unpriced: boolean;
}

export function observedCost(turns: Turn[]): CostBreakdown {
  let costUSD = 0;
  let unpriced = false;
  for (const turn of turns) {
    const result = price(turn.model, turn.timestamp, turn);
    if (result.unpriced || result.costUSD == null) unpriced = true;
    else costUSD += result.costUSD;
  }
  return { costUSD, unpriced };
}

export interface DeltaBreakdown {
  outputUSD: number;
  writeUSD: number;
  readUSD: number;
  totalUSD: number;
}

export function replayDelta(
  turns: Turn[],
  proseTokens: number[],
  f: (turn: Turn, index: number) => number,
  injectionDelta: (turn: Turn, index: number) => number,
): DeltaBreakdown | null {
  let outputUSD = 0;
  let writeUSD = 0;
  let readUSD = 0;
  let pendingWrite = 0;
  let inPrefix = 0;

  for (const [index, turn] of turns.entries()) {
    const rates = ratesFor(turn.model, turn.timestamp);
    if (!rates) return null;
    const cw = writeMultiplier(turn, rates);

    pendingWrite += injectionDelta(turn, index);

    writeUSD += pendingWrite * rates.input * cw;
    readUSD += inPrefix * rates.input * (isColdStart(turn) ? cw : rates.read);
    inPrefix += pendingWrite;
    pendingWrite = 0;

    const proseDelta = (proseTokens[index] ?? 0) * (f(turn, index) - 1);
    outputUSD += proseDelta * rates.output;
    pendingWrite += proseDelta;
  }

  return { outputUSD, writeUSD, readUSD, totalUSD: outputUSD + writeUSD + readUSD };
}

export interface SessionResult {
  sessionId: string;
  file: string;
  cavemanActive: boolean;
  turns: number;

  proseTokens: number;

  userPrompts: number;

  actualUSD: number;

  paidUSD: number;
  vanillaUSD: number;
  optimizedUSD: number;
  unpriced: boolean;

  modelled: boolean;

  delta: DeltaBreakdown | null;
}

export function replaySession(
  session: SessionAnalysis,
  proseTokens: number[],

  effectiveRatio: (turn: Turn, index: number) => number,
  profile: InjectionProfile,
  injectedTokensPerTurn: number[],

  redundantTokensPerTurn: number[] = [],
): SessionResult {
  const observed = observedCost(session.turns);
  const base: SessionResult = {
    sessionId: session.sessionId,
    file: session.file,
    cavemanActive: session.cavemanActive,
    turns: session.turns.length,
    proseTokens: proseTokens.reduce((total, tokens) => total + tokens, 0),
    userPrompts: session.turns.reduce((total, turn) => total + turn.userPromptsBefore, 0),
    actualUSD: observed.costUSD,
    paidUSD: observed.costUSD,
    vanillaUSD: observed.costUSD,
    optimizedUSD: observed.costUSD,
    unpriced: observed.unpriced,
    modelled: false,
    delta: null,
  };

  if (session.cavemanActive) {
    const delta = replayDelta(
      session.turns,
      proseTokens,
      (turn, index) => 1 / effectiveRatio(turn, index),
      (_turn, index) => -(injectedTokensPerTurn[index] ?? 0),
    );
    if (!delta) return base;

    const redundant = replayDelta(
      session.turns,
      proseTokens,
      () => 1,
      (_turn, index) => -(redundantTokensPerTurn[index] ?? 0),
    );
    return {
      ...base,
      actualUSD: observed.costUSD + (redundant?.totalUSD ?? 0),
      vanillaUSD: observed.costUSD + delta.totalUSD,
      modelled: true,
      delta,
    };
  }

  const delta = replayDelta(session.turns, proseTokens, effectiveRatio, (turn, index) => {
    const oneTime = index === 0 ? profile.oneTimeTokens : 0;
    return oneTime + turn.userPromptsBefore * profile.perPromptTokens;
  });
  if (!delta) return base;
  return { ...base, optimizedUSD: observed.costUSD + delta.totalUSD, modelled: true, delta };
}

export interface Totals {
  actualUSD: number;

  paidUSD: number;

  misconfiguredUSD: number;
  vanillaUSD: number;
  optimizedUSD: number;
  savedUSD: number;
  savedPct: number;
  availableUSD: number;
  availablePct: number;
  sessions: number;
  sessionsWithTool: number;
}

export function totalsOf(results: SessionResult[]): Totals {
  const sum = (pick: (r: SessionResult) => number) => results.reduce((a, r) => a + pick(r), 0);
  const actualUSD = sum((r) => r.actualUSD);
  const paidUSD = sum((r) => r.paidUSD);
  const vanillaUSD = sum((r) => r.vanillaUSD);
  const optimizedUSD = sum((r) => r.optimizedUSD);
  return {
    actualUSD,
    paidUSD,
    misconfiguredUSD: paidUSD - actualUSD,
    vanillaUSD,
    optimizedUSD,
    savedUSD: vanillaUSD - actualUSD,
    savedPct: vanillaUSD === 0 ? 0 : (vanillaUSD - actualUSD) / vanillaUSD,
    availableUSD: actualUSD - optimizedUSD,
    availablePct: vanillaUSD === 0 ? 0 : (actualUSD - optimizedUSD) / vanillaUSD,
    sessions: results.length,
    sessionsWithTool: results.filter((r) => r.cavemanActive).length,
  };
}
