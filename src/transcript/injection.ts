import type { SessionAnalysis } from './session.js';
import type { TokenCounter } from './tokens.js';

export interface InjectionProfile {
  oneTimeTokens: number;

  perPromptTokens: number;
  sessions: number;
  /** True when nothing local measured this and SHIPPED_PROFILE stood in. */
  borrowed: boolean;
}

/**
 * What caveman costs to have switched on, for a corpus that never switched it on.
 *
 * The midpoint of the two corpora that ran a correctly configured install end to end:
 * 457 tok one-time / 34 per prompt over 29 sessions, and 467 / 50 over 69.
 *
 * Without this, `median([])` returns 0 and a corpus with no caveman sessions prices the
 * SessionStart ruleset and every per-prompt reminder at nothing — the projection then reports
 * a saving with the cost side missing. On the four English corpora that error was the entire
 * result: the tool looked like it paid for itself, and it does not.
 */
export const SHIPPED_PROFILE: InjectionProfile = {
  oneTimeTokens: 462,
  perPromptTokens: 42,
  sessions: 0,
  borrowed: true,
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export async function measureInjectionProfile(
  sessions: SessionAnalysis[],
  counter: TokenCounter,
): Promise<InjectionProfile> {
  const oneTime: number[] = [];
  const perPrompt: number[] = [];
  let active = 0;

  for (const session of sessions) {
    if (!session.cavemanActive || session.turns.length === 0) continue;
    active++;
    const model = session.turns[0]!.model;

    let sessionOneTime = 0;
    let sessionPerPrompt = 0;
    let prompts = 0;
    for (const turn of session.turns) {
      for (const text of new Set(turn.injectedOneTime)) sessionOneTime += await counter.count(text, model);
      for (const text of new Set(turn.injectedPerTurn)) sessionPerPrompt += await counter.count(text, model);
      prompts += turn.userPromptsBefore;
    }
    oneTime.push(sessionOneTime);

    if (prompts > 0) perPrompt.push(sessionPerPrompt / prompts);
  }

  // Nothing here ran caveman, so nothing here measured its cost. The counterfactual asks what
  // these sessions would have cost WITH the tool, and the tool is not free.
  if (active === 0) return { ...SHIPPED_PROFILE };

  return {
    oneTimeTokens: median(oneTime),
    perPromptTokens: median(perPrompt),
    sessions: active,
    borrowed: false,
  };
}

export async function redundantTokensOf(session: SessionAnalysis, counter: TokenCounter): Promise<number[]> {
  const model = session.turns[0]?.model ?? '';
  const out: number[] = [];
  for (const turn of session.turns) {
    const seen = new Map<string, number>();
    for (const text of [...turn.injectedOneTime, ...turn.injectedPerTurn]) {
      seen.set(text, (seen.get(text) ?? 0) + 1);
    }
    let redundant = 0;
    for (const [text, times] of seen) {
      if (times > 1) redundant += (times - 1) * (await counter.count(text, turn.model || model));
    }
    out.push(redundant);
  }
  return out;
}
