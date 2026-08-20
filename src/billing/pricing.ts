interface Rate {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2.0;
const CACHE_READ_MULTIPLIER = 0.1;

function anthropic(input: number, output: number): Rate {
  return {
    input,
    output,
    cacheRead: input * CACHE_READ_MULTIPLIER,
    cacheWrite5m: input * CACHE_WRITE_5M_MULTIPLIER,
    cacheWrite1h: input * CACHE_WRITE_1H_MULTIPLIER,
  };
}

function openai(input: number, cachedInput: number, output: number, cacheWrite = 0): Rate {
  return { input, output, cacheRead: cachedInput, cacheWrite5m: cacheWrite, cacheWrite1h: cacheWrite };
}

const ANTHROPIC_RATES: Record<string, Rate> = {
  'claude-fable-5': anthropic(10.0, 50.0),
  'claude-mythos-5': anthropic(10.0, 50.0),

  'claude-opus-5': anthropic(5.0, 25.0),
  'claude-opus-4-8': anthropic(5.0, 25.0),
  'claude-opus-4-7': anthropic(5.0, 25.0),
  'claude-opus-4-6': anthropic(5.0, 25.0),
  'claude-sonnet-4-6': anthropic(3.0, 15.0),
  'claude-haiku-4-5': anthropic(1.0, 5.0),
};

const OPENAI_RATES: Record<string, Rate> = {
  'gpt-5.6-sol': openai(5.0, 0.5, 30.0, 6.25),
  'gpt-5.6-terra': openai(2.5, 0.25, 15.0, 3.125),
  'gpt-5.6-luna': openai(1.0, 0.1, 6.0, 1.25),
  'gpt-5.5': openai(5.0, 0.5, 30.0),
  'gpt-5.5-pro': openai(30.0, 30.0, 180.0),
  'gpt-5.4': openai(2.5, 0.25, 15.0),
  'gpt-5.4-mini': openai(0.75, 0.075, 4.5),
  'gpt-5.4-nano': openai(0.2, 0.02, 1.25),
  'gpt-5.4-pro': openai(30.0, 30.0, 180.0),

  'gpt-5.3-codex': openai(1.75, 0.175, 14.0),

  'gpt-5.2': openai(1.75, 0.175, 14.0),
  'gpt-5.2-codex': openai(1.75, 0.175, 14.0),
  'gpt-5.2-pro': openai(21.0, 21.0, 168.0),
  'gpt-5.1': openai(1.25, 0.125, 10.0),
  'gpt-5.1-codex': openai(1.25, 0.125, 10.0),
  'gpt-5.1-codex-max': openai(1.25, 0.125, 10.0),
  'gpt-5.1-codex-mini': openai(0.25, 0.025, 2.0),
  'gpt-5': openai(1.25, 0.125, 10.0),
  'gpt-5-codex': openai(1.25, 0.125, 10.0),
  'gpt-5-mini': openai(0.25, 0.025, 2.0),
  'gpt-5-nano': openai(0.05, 0.005, 0.4),
  'gpt-5-pro': openai(15.0, 15.0, 120.0),
  'codex-mini-latest': openai(1.5, 0.375, 6.0),
};

const RATES: Record<string, Rate> = { ...ANTHROPIC_RATES, ...OPENAI_RATES };

const SONNET_5_INTRO: Rate = anthropic(2.0, 10.0);
const SONNET_5_STANDARD: Rate = anthropic(3.0, 15.0);
const SONNET_5_INTRO_CUTOFF = new Date('2026-08-31T23:59:59.999Z');

export interface PriceableTokens {
  inputTokens: number;
  outputTokens: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export interface PriceResult {
  costUSD: number | null;
  unpriced: boolean;
}

function normaliseModelId(model: string): string {
  return model.replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{8}$/, '');
}

function rateFor(model: string, timestamp: Date): Rate | null {
  const normalised = normaliseModelId(model);
  if (normalised === 'claude-sonnet-5') {
    return timestamp <= SONNET_5_INTRO_CUTOFF ? SONNET_5_INTRO : SONNET_5_STANDARD;
  }
  return RATES[normalised] ?? null;
}

export function price(model: string, timestamp: Date, tokens: PriceableTokens): PriceResult {
  const rate = rateFor(model, timestamp);
  if (!rate) {
    return { costUSD: null, unpriced: true };
  }

  const inputCost =
    (tokens.inputTokens * rate.input +
      tokens.cacheWrite5m * rate.cacheWrite5m +
      tokens.cacheWrite1h * rate.cacheWrite1h +
      tokens.cacheRead * rate.cacheRead) /
    1_000_000;
  const outputCost = (tokens.outputTokens * rate.output) / 1_000_000;

  return { costUSD: inputCost + outputCost, unpriced: false };
}
