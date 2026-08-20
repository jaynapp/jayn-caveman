import { test } from 'node:test';
import assert from 'node:assert/strict';
import { price } from './pricing.js';

const zeroTokens = { inputTokens: 0, outputTokens: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };

test('date-suffixed model id resolves to base rate', () => {
  const withSuffix = price('claude-haiku-4-5-20251001', new Date('2026-01-01'), {
    ...zeroTokens,
    inputTokens: 1_000_000,
  });
  const base = price('claude-haiku-4-5', new Date('2026-01-01'), { ...zeroTokens, inputTokens: 1_000_000 });
  assert.equal(withSuffix.costUSD, 1.0);
  assert.equal(withSuffix.costUSD, base.costUSD);
});

test('unknown model id is unpriced, not zero', () => {
  const result = price('claude-opus-4-5', new Date('2026-01-01'), { ...zeroTokens, inputTokens: 1_000_000 });
  assert.equal(result.costUSD, null);
  assert.equal(result.unpriced, true);
});

test('sonnet 5 intro rate applies on/before 2026-08-31', () => {
  const before = price('claude-sonnet-5', new Date('2026-08-31T23:59:59Z'), {
    ...zeroTokens,
    inputTokens: 1_000_000,
  });
  const after = price('claude-sonnet-5', new Date('2026-09-01T00:00:00Z'), {
    ...zeroTokens,
    inputTokens: 1_000_000,
  });
  assert.equal(before.costUSD, 2.0);
  assert.equal(after.costUSD, 3.0);
});

test('openai cached input is billed at its published rate, not an anthropic multiplier', () => {
  const result = price('gpt-5.6-terra', new Date('2026-07-01'), {
    ...zeroTokens,
    inputTokens: 1_000_000,
    cacheRead: 1_000_000,
    cacheWrite5m: 1_000_000,
  });

  assert.equal(result.costUSD, 5.875);
});

test('an openai model with no published cache-write rate charges nothing for writes', () => {
  const withWrites = price('gpt-5.4', new Date('2026-07-01'), {
    ...zeroTokens,
    cacheWrite5m: 1_000_000,
  });
  assert.equal(withWrites.costUSD, 0);
});

test('dated openai snapshot ids resolve to the base rate', () => {
  const dated = price('gpt-5.4-2026-03-05', new Date('2026-07-01'), {
    ...zeroTokens,
    inputTokens: 1_000_000,
  });
  assert.equal(dated.costUSD, 2.5);
});

test('an unknown codex model is unpriced, not zero', () => {
  const result = price('gpt-5.3-codex-spark', new Date('2026-07-01'), {
    ...zeroTokens,
    inputTokens: 1_000_000,
  });
  assert.equal(result.costUSD, null);
  assert.equal(result.unpriced, true);
});

test('cache multipliers apply to input rate', () => {
  const result = price('claude-opus-4-8', new Date('2026-01-01'), {
    inputTokens: 0,
    outputTokens: 0,
    cacheWrite5m: 1_000_000,
    cacheWrite1h: 1_000_000,
    cacheRead: 1_000_000,
  });

  assert.equal(result.costUSD, 16.75);
});
