import { readFile } from 'node:fs/promises';
import { globSync } from 'node:fs';
import { join } from 'node:path';
import { price } from '../../../billing/pricing.js';
import { analyzeSession, type SessionAnalysis } from '../../../transcript/session.js';
import { admissible, leaksIn, type Arm, type LeakReport } from './arms.js';
import { PROMPTS, type TrialPrompt } from './prompts.js';
import type { RunRecord } from './run.js';

/**
 * Hand-run interactive sessions into the trial ledger.
 *
 * The headless runner launches the run, so it knows which prompt and which arm it asked for.
 * Driving by hand gives that up. Both facts are recovered from the transcript rather than from
 * an operator's notes, because notes are exactly what goes wrong quietly:
 *
 * - which prompt: the session's first human message, matched on collapsed whitespace
 * - which arm: the injections in the transcript, through the same check the runner used
 * - which repeat: completion order within (prompt, model, arm), so the k-th ON pairs with the
 *   k-th OFF
 */

export function normalisePrompt(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

const BY_TEXT = new Map(PROMPTS.map((prompt) => [normalisePrompt(prompt.text), prompt]));

export function matchPrompt(text: string): TrialPrompt | undefined {
  return BY_TEXT.get(normalisePrompt(text));
}

/**
 * The first thing a human typed. Tool results, hook attachments and `<system-reminder>` blocks
 * are all written as `user` events too, so each is excluded by shape rather than by heuristic.
 */
export async function firstUserPrompt(file: string): Promise<string | null> {
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type !== 'user' || event.toolUseResult !== undefined || event.attachment) continue;
    const message = event.message as { content?: unknown } | undefined;
    const content = message?.content;
    const raw =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter((block) => (block as { type?: string })?.type === 'text')
              .map((block) => (block as { text?: string }).text ?? '')
              .join('')
          : '';
    const text = raw.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').trim();
    if (text) return text;
  }
  return null;
}

/** The model a session ran on: the one that wrote the most turns, not merely the first. */
function modelOf(session: SessionAnalysis): string {
  const counts = new Map<string, number>();
  for (const turn of session.turns) counts.set(turn.model, (counts.get(turn.model) ?? 0) + 1);
  let best = '';
  let most = 0;
  for (const [model, count] of counts) {
    if (count > most) [best, most] = [model, count];
  }
  return best;
}

function costOf(session: SessionAnalysis): number {
  let total = 0;
  for (const turn of session.turns) {
    const { costUSD } = price(turn.model, turn.timestamp, turn);
    total += costUSD ?? 0;
  }
  return total;
}

function wallMsOf(session: SessionAnalysis): number {
  const times = session.turns.map((turn) => turn.timestamp.getTime());
  return times.length > 1 ? Math.max(...times) - Math.min(...times) : 0;
}

export interface Rejection {
  file: string;
  reason: 'already recorded' | 'leaked' | 'no turns' | 'wrong model';
  detail?: string;
}

export interface ImportReport {
  records: RunRecord[];
  rejected: Rejection[];
  scanned: number;
  matched: number;
}

export interface ImportOptions {
  from: string;
  existing: readonly RunRecord[];
  since?: Date;
  model?: string;
  operator?: string;
}

export async function importSessions(options: ImportOptions): Promise<ImportReport> {
  const { from, existing, since, model, operator } = options;
  const seen = new Set(existing.map((record) => record.sessionId));
  const nextRepeat = new Map<string, number>();
  for (const record of existing) {
    const key = `${record.promptId}/${record.model}/${record.arm}`;
    nextRepeat.set(key, Math.max(nextRepeat.get(key) ?? 0, record.repeat + 1));
  }

  const files = globSync(join(from, '**', '*.jsonl')).sort();
  const rejected: Rejection[] = [];
  const candidates: {
    file: string;
    session: SessionAnalysis;
    prompt: TrialPrompt;
    arm: Arm;
    leaks: LeakReport;
    at: number;
  }[] = [];
  let matched = 0;

  for (const file of files) {
    const text = await firstUserPrompt(file);
    if (!text) continue;
    const prompt = matchPrompt(text);
    if (!prompt) continue;
    matched++;

    const session = await analyzeSession(file);
    if (session.turns.length === 0) {
      rejected.push({ file, reason: 'no turns', detail: prompt.id });
      continue;
    }
    const at = Math.min(...session.turns.map((turn) => turn.timestamp.getTime()));
    if (since && at < since.getTime()) continue;
    if (seen.has(session.sessionId)) {
      rejected.push({ file, reason: 'already recorded', detail: prompt.id });
      continue;
    }
    const sessionModel = modelOf(session);
    if (model && sessionModel !== model) {
      rejected.push({ file, reason: 'wrong model', detail: `${prompt.id} ran on ${sessionModel}` });
      continue;
    }

    const leaks = leaksIn((await readFile(file, 'utf8')).split('\n'));
    const arm: Arm = leaks.cavemanInjections > 0 ? 'on' : 'off';
    if (!admissible(arm, leaks)) {
      rejected.push({
        file,
        reason: 'leaked',
        detail: `${prompt.id} ${arm} — rtk ${leaks.rtk}, ctx ${leaks.ctx}`,
      });
      continue;
    }
    candidates.push({ file, session, prompt, arm, leaks, at });
  }

  // Completion order is what pairs the arms, so repeats are assigned once every candidate is
  // known rather than in filesystem order.
  candidates.sort((a, b) => a.at - b.at);

  const records: RunRecord[] = [];
  for (const { file, session, prompt, arm, leaks } of candidates) {
    const sessionModel = modelOf(session);
    const key = `${prompt.id}/${sessionModel}/${arm}`;
    const repeat = nextRepeat.get(key) ?? 0;
    nextRepeat.set(key, repeat + 1);
    records.push({
      ...(operator ? { operator } : {}),
      promptId: prompt.id,
      model: sessionModel,
      arm,
      repeat,
      sessionId: session.sessionId,
      transcript: file,
      costUsd: costOf(session),
      numTurns: session.turns.length,
      wallMs: wallMsOf(session),
      leaks,
      admissible: true,
    });
  }

  return { records, rejected, scanned: files.length, matched };
}
