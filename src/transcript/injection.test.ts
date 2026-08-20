import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureInjectionProfile, redundantTokensOf } from './injection.js';
import type { SessionAnalysis, Turn } from './session.js';
import type { TokenCounter } from './tokens.js';

const counter: TokenCounter = {
  count: async (text: string) => (text.trim() === '' ? 0 : text.trim().split(/\s+/).length),
} as TokenCounter;

function turn(injected: { oneTime?: string[]; perTurn?: string[]; prompts?: number }): Turn {
  return {
    model: 'claude-opus-5',
    injectedOneTime: injected.oneTime ?? [],
    injectedPerTurn: injected.perTurn ?? [],
    userPromptsBefore: injected.prompts ?? 0,
  } as unknown as Turn;
}

function session(turns: Turn[]): SessionAnalysis {
  return { file: 'f', sessionId: 's', cavemanActive: true, turns } as unknown as SessionAnalysis;
}

const REMINDER = 'caveman mode active drop articles';

test('the profile prices one registration, not both copies of a doubled hook', async () => {
  const doubled = session([turn({ oneTime: [REMINDER, REMINDER], prompts: 1 })]);
  const single = session([turn({ oneTime: [REMINDER], prompts: 1 })]);
  const a = await measureInjectionProfile([doubled], counter);
  const b = await measureInjectionProfile([single], counter);
  assert.equal(a.oneTimeTokens, b.oneTimeTokens, 'a doubled hook must price the same as a single one');
  assert.equal(a.oneTimeTokens, 5);
});

test('two DIFFERENT blocks on one turn both count — only identical text is redundant', async () => {
  const s = session([turn({ perTurn: ['alpha beta', 'gamma delta epsilon'], prompts: 1 })]);
  const profile = await measureInjectionProfile([s], counter);
  assert.equal(profile.perPromptTokens, 5, 'distinct blocks are additive');
});

test('redundant tokens are the copies beyond the first, per turn', async () => {
  const s = session([
    turn({ oneTime: [REMINDER, REMINDER] }),
    turn({ perTurn: [REMINDER] }),
    turn({ perTurn: [REMINDER, REMINDER, REMINDER] }),
  ]);
  assert.deepEqual(await redundantTokensOf(s, counter), [5, 0, 10]);
});

test('the same reminder on many turns is not redundant', async () => {
  const s = session([turn({ perTurn: [REMINDER] }), turn({ perTurn: [REMINDER] })]);
  assert.deepEqual(await redundantTokensOf(s, counter), [0, 0]);
});

test('a clean session reports no redundancy at all', async () => {
  const s = session([turn({ oneTime: ['alpha'], perTurn: ['beta gamma'] })]);
  assert.deepEqual(await redundantTokensOf(s, counter), [0]);
});
