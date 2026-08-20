export const TIERS = ['oneshot', 'short', 'long'] as const;
export type Tier = (typeof TIERS)[number];

export interface TrialPrompt {
  id: string;
  tier: Tier;
  text: string;
}

const ONESHOT: TrialPrompt[] = [
  {
    id: 'rebase-vs-merge',
    tier: 'oneshot',
    text: 'Explain the difference between git rebase and git merge. When should I use each one, and what are the tradeoffs?',
  },
  {
    id: 'jwt-expiry',
    tier: 'oneshot',
    text: "My Express auth middleware lets expired JWTs through. The expiry check compares Date.now() to the token's exp field. What is wrong and how do I fix it?",
  },
  {
    id: 'pool-config',
    tier: 'oneshot',
    text: 'How do I set up a PostgreSQL connection pool in Node.js with sensible timeout and error handling configuration?',
  },
  {
    id: 'index-slowdown',
    tier: 'oneshot',
    text: 'When does adding a database index make a query slower instead of faster? Give me the cases and how I would spot each one.',
  },
  {
    id: 'backoff-jitter',
    tier: 'oneshot',
    text: 'What does jitter actually buy me on top of exponential backoff, and how do I pick the base delay and the cap for a client retrying a flaky HTTP API?',
  },
];

const SHORT: TrialPrompt[] = [
  {
    id: 'style-floor',
    tier: 'short',
    text: 'In this repository, what does styleOf return for a turn shorter than its minimum, and which callers drop that turn as a result?',
  },
  {
    id: 'lastofrun-rule',
    tier: 'short',
    text: 'Read src/transcript/session.ts and tell me the exact rule that decides whether a turn closes a run, and why it takes the whole turn list.',
  },
  {
    id: 'ratio-provenance',
    tier: 'short',
    text: 'Where does the 0.35 prose ratio come from in this repository, and which turns is it actually measured on?',
  },
  {
    id: 'cache-tiers',
    tier: 'short',
    text: 'In this repository, how does src/billing/pricing.ts price a 5-minute cache write against a 1-hour one, and which callers depend on the two being kept apart?',
  },
  {
    id: 'unknown-flag',
    tier: 'short',
    text: 'Read src/cli/args.ts and tell me exactly what happens to an unknown flag, and what stops a value flag from swallowing the next positional argument.',
  },
];

const LONG: TrialPrompt[] = [
  {
    id: 'add-test-lastofrun',
    tier: 'long',
    text: 'Add unit tests for lastOfRunFlags in src/transcript/session.ts covering the single-turn case, a two-run session, and a session whose final turn is mid-run. Run the test suite for that file and fix anything that fails.',
  },
  {
    id: 'trace-pfire',
    tier: 'long',
    text: 'Trace how p_fire is fitted in this repository, from raw transcripts through to the number the report prints. Name each file in the chain and what it contributes, then tell me which step is the weakest link.',
  },
  {
    id: 'audit-band-edges',
    tier: 'long',
    text: 'Audit the BANDS table in src/effects/caveman/compliance.ts: check that the edges are contiguous, that BAND_WEIGHT matches them, and that every consumer handles the top band. Write a test for whichever property is currently untested.',
  },
  {
    id: 'test-replay-edges',
    tier: 'long',
    text: 'Add unit tests for src/transcript/replay.ts covering a single-turn session, a change at the very last turn, and a session where the changed turn writes zero tokens. Run the test suite for that file and fix anything that fails.',
  },
  {
    id: 'audit-pricing-table',
    tier: 'long',
    text: 'Audit src/billing/pricing.ts: check that every model in the rate table has all five token rates, that the dated-snapshot suffix stripping cannot collide two different models, and that an unpriced model is reported rather than charged zero. Write a test for whichever property is currently untested.',
  },
];

export const PROMPTS: readonly TrialPrompt[] = [...ONESHOT, ...SHORT, ...LONG];

export function promptById(id: string): TrialPrompt | undefined {
  return PROMPTS.find((prompt) => prompt.id === id);
}

/**
 * Split the prompt list between operators, as `k/n` — shard 1 of 2, and so on.
 *
 * Two people sharing a design need disjoint prompts, not a disjoint stretch of the queue: `next`
 * recomputes what is outstanding from the ledger on every call, so "you start from the end" drifts
 * the moment either of them records a run. Sharing a prompt is worse than duplicated effort. The
 * k-th ON run pairs with the k-th OFF run by completion order, so a prompt run by both people
 * merges into pairs that straddle them, and on the interactive tiers the operator is half of what
 * the pair measures.
 *
 * Prompts are dealt within tier rather than across the flat list, so every shard covers every
 * tier. An operator effect then spreads over all three cells instead of landing entirely on one,
 * where it would be indistinguishable from the cell itself.
 */
export function shard(prompts: readonly TrialPrompt[], spec: string): TrialPrompt[] {
  const [k, n] = spec.split('/').map(Number);
  if (!Number.isInteger(k) || !Number.isInteger(n) || n < 1 || k < 1 || k > n) {
    throw new Error(`--shard wants k/n with 1 <= k <= n, got "${spec}"`);
  }
  const mine = new Set<string>();
  for (const tier of TIERS) {
    prompts
      .filter((prompt) => prompt.tier === tier)
      .forEach((prompt, index) => {
        if (index % n === k - 1) mine.add(prompt.id);
      });
  }
  return prompts.filter((prompt) => mine.has(prompt.id));
}
