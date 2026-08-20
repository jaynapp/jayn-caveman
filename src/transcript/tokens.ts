import { getTokenizer } from '@anthropic-ai/tokenizer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface TokenCounter {
  count(text: string, model: string): Promise<number>;
}

let tokenizer: ReturnType<typeof getTokenizer> | null = null;

const legacyCounts = new Map<string, number>();

export function memoCountTokens(text: string): number {
  const hit = legacyCounts.get(text);
  if (hit !== undefined) return hit;
  tokenizer ??= getTokenizer();
  const count = tokenizer.encode(text.normalize('NFKC'), 'all').length;
  legacyCounts.set(text, count);
  return count;
}

const COUNT_TOKENS_URL = 'https://api.anthropic.com/v1/messages/count_tokens';
const CACHE_PATH = join(homedir(), '.cache', 'jayn-caveman', 'token-counts.json');

export function resolveApiKey(): string | null {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const out = execFileSync('zsh', ['-ic', 'echo $ANTHROPIC_API_KEY'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const key = out.trim().split('\n').pop()?.trim();
    return key || null;
  } catch {
    return null;
  }
}

const PROBE_A = 'The quick brown fox jumps over the lazy dog. '.repeat(8);
const PROBE_B = 'Pack my box with five dozen liquor jugs today. '.repeat(8);

interface DiskCache {
  counts: Record<string, number>;
  overheads: Record<string, number>;
}

function loadCache(path: string): DiskCache {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DiskCache;
  } catch {
    return { counts: {}, overheads: {} };
  }
}

export class ApiCounter implements TokenCounter {
  private readonly cache: DiskCache;
  private dirty = false;

  constructor(
    private readonly apiKey: string,
    private readonly cachePath: string = CACHE_PATH,
  ) {
    this.cache = loadCache(cachePath);
  }

  private async raw(text: string, model: string): Promise<number> {
    const response = await fetch(COUNT_TOKENS_URL, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: text }] }),
    });
    const body = (await response.json()) as { input_tokens?: number; error?: { message?: string } };
    if (typeof body.input_tokens !== 'number') {
      throw new Error(`count_tokens failed for ${model}: ${body.error?.message ?? 'unknown'}`);
    }
    return body.input_tokens;
  }

  private async overheadFor(model: string): Promise<number> {
    const cached = this.cache.overheads[model];
    if (cached !== undefined) return cached;

    const pairs: Array<[string, string]> = [
      [PROBE_A, PROBE_B],
      [PROBE_B, PROBE_A],
      [PROBE_A, PROBE_A],
      [PROBE_B + PROBE_A, PROBE_B],
    ];
    const estimates = await Promise.all(
      pairs.map(async ([left, right]) => {
        const [a, b, ab] = await Promise.all([
          this.raw(left, model),
          this.raw(right, model),
          this.raw(left + right, model),
        ]);
        return a + b - ab;
      }),
    );
    estimates.sort((x, y) => x - y);
    const overhead = estimates[Math.floor(estimates.length / 2)]!;

    this.cache.overheads[model] = overhead;
    this.dirty = true;
    return overhead;
  }

  async count(text: string, model: string): Promise<number> {
    if (!text) return 0;
    const key = `${model}:${createHash('sha256').update(text).digest('hex')}`;
    const hit = this.cache.counts[key];
    if (hit !== undefined) return hit;

    const [withOverhead, overhead] = await Promise.all([this.raw(text, model), this.overheadFor(model)]);
    const tokens = Math.max(0, withOverhead - overhead);
    this.cache.counts[key] = tokens;
    this.dirty = true;
    return tokens;
  }

  flush(): void {
    if (!this.dirty) return;
    mkdirSync(dirname(this.cachePath), { recursive: true });
    writeFileSync(this.cachePath, JSON.stringify(this.cache));
    this.dirty = false;
  }
}

const CLAUDE_5 = 'claude-5';
const CLAUDE_4 = 'claude-4';

export const TOKENIZER_FAMILY: Record<string, string> = {
  'claude-opus-5': CLAUDE_5,
  'claude-sonnet-5': CLAUDE_5,
  'claude-fable-5': CLAUDE_5,
  'claude-mythos-5': CLAUDE_5,
  'claude-opus-4-8': CLAUDE_5,
  'claude-opus-4-6': CLAUDE_4,
  'claude-opus-4-7': CLAUDE_4,
  'claude-sonnet-4-6': CLAUDE_4,
  'claude-haiku-4-5': CLAUDE_4,
};

export const PRIOR_BPE_FACTOR: Record<string, number> = {
  [CLAUDE_5]: 1.4545,
  [CLAUDE_4]: 1.048,
};

const GLOBAL_PRIOR = PRIOR_BPE_FACTOR[CLAUDE_5]!;

const MIN_LOCAL_SAMPLES = 8;

export interface Calibration {
  family: string;

  factor: number;
  samples: number;
  source: 'local' | 'prior' | 'global';
}

function normaliseModel(model: string): string {
  return model.replace(/-\d{8}$/, '');
}

export function familyOf(model: string): string {
  return TOKENIZER_FAMILY[normaliseModel(model)] ?? 'unknown';
}

export function calibrate(
  samples: Array<{ model: string; legacyTokens: number; tokens: number }>,
): Map<string, Calibration> {
  const grouped = new Map<string, number[]>();
  for (const sample of samples) {
    if (sample.tokens <= 0 || sample.legacyTokens <= 0) continue;
    const family = familyOf(sample.model);
    const list = grouped.get(family) ?? [];
    list.push(sample.tokens / sample.legacyTokens);
    grouped.set(family, list);
  }

  const out = new Map<string, Calibration>();
  for (const [family, ratios] of grouped) {
    if (ratios.length < MIN_LOCAL_SAMPLES) continue;
    const sorted = [...ratios].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const factor = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
    out.set(family, { family, factor, samples: ratios.length, source: 'local' });
  }
  return out;
}

export class BpeCounter implements TokenCounter {
  readonly used = new Map<string, Calibration>();

  constructor(
    private readonly local: Map<string, Calibration> = new Map(),
    private readonly legacyCount: (text: string) => number = memoCountTokens,
  ) {}

  calibrationFor(model: string): Calibration {
    const family = familyOf(model);
    const cached = this.used.get(family);
    if (cached) return cached;

    const local = this.local.get(family);
    const prior = PRIOR_BPE_FACTOR[family];
    const chosen: Calibration = local
      ? local
      : prior !== undefined
        ? { family, factor: prior, samples: 0, source: 'prior' }
        : { family, factor: GLOBAL_PRIOR, samples: 0, source: 'global' };
    this.used.set(family, chosen);
    return chosen;
  }

  async count(text: string, model: string): Promise<number> {
    if (!text) return 0;
    return Math.round(this.legacyCount(text) * this.calibrationFor(model).factor);
  }
}

export interface CounterCheck {
  samples: number;
  meanRatio: number;
  withinTolerance: boolean;
}

export async function verifyCounter(
  counter: TokenCounter,
  samples: Array<{ text: string; model: string; billedTokens: number }>,
  tolerance = 0.02,
): Promise<CounterCheck> {
  if (samples.length === 0) return { samples: 0, meanRatio: NaN, withinTolerance: false };
  let sum = 0;
  for (const sample of samples) {
    const counted = await counter.count(sample.text, sample.model);
    sum += counted / sample.billedTokens;
  }
  const meanRatio = sum / samples.length;
  return {
    samples: samples.length,
    meanRatio,
    withinTolerance: Math.abs(meanRatio - 1) <= tolerance,
  };
}
