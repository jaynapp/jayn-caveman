import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { globSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { armDir, admissible, leaksIn, ARMS, type Arm, type LeakReport } from './arms.js';
import { PROMPTS, type TrialPrompt } from './prompts.js';

const exec = promisify(execFile);

export interface RunPlan {
  promptId: string;
  model: string;
  arm: Arm;
  repeat: number;
}

export interface RunRecord extends RunPlan {
  /** Who ran it. Unset on runs recorded before the trial was shared between operators. */
  operator?: string;

  sessionId: string;
  transcript: string;
  costUsd: number;
  numTurns: number;
  wallMs: number;
  leaks: LeakReport;

  admissible: boolean;
}

export const LEDGER = 'runs.jsonl';

export function planKey(plan: RunPlan): string {
  return `${plan.promptId}/${plan.model}/${plan.repeat}/${plan.arm}`;
}

export function pairKey(plan: Omit<RunPlan, 'arm'>): string {
  return `${plan.promptId}/${plan.model}/${plan.repeat}`;
}

export function planRuns(
  prompts: readonly TrialPrompt[],
  repeats: number,
  model: string,
  done: ReadonlySet<string> = new Set(),
): RunPlan[] {
  const plans: RunPlan[] = [];
  for (const prompt of prompts) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      const order: readonly Arm[] = repeat % 2 === 0 ? ARMS : [...ARMS].reverse();
      for (const arm of order) {
        const plan = { promptId: prompt.id, model, arm, repeat };
        if (!done.has(planKey(plan))) plans.push(plan);
      }
    }
  }
  return plans;
}

export async function completedRuns(root: string): Promise<Set<string>> {
  const done = new Set<string>();
  const text = await readFile(join(root, LEDGER), 'utf8').catch(() => '');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      done.add(planKey(JSON.parse(line) as RunPlan));
    } catch {
      continue;
    }
  }
  return done;
}

interface HeadlessResult {
  session_id?: string;
  total_cost_usd?: number;
  num_turns?: number;
  is_error?: boolean;
  result?: string;
  api_error_status?: number;
}

const FATAL = [/credit balance is too low/i, /invalid api key/i, /authentication/i, /quota/i];

export class TrialHalted extends Error {}

function envelopeIn(text: string): HeadlessResult | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start)) as HeadlessResult;
  } catch {
    return null;
  }
}

function fatalReason(text: string): string | null {
  if (!FATAL.some((pattern) => pattern.test(text))) return null;
  const envelope = envelopeIn(text);
  if (envelope?.result) {
    return `${envelope.result}${envelope.api_error_status ? ` (HTTP ${envelope.api_error_status})` : ''}`;
  }
  return text.trim();
}

async function headless(prompt: string, arm: Arm, root: string, sandbox: string, model: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CONFIG_DIR: armDir(root, arm),

    CAVEMAN_DEFAULT_MODE: arm === 'on' ? 'full' : 'off',
  };
  const args = [
    '-p',
    prompt,
    '--model',
    model,
    '--permission-mode',
    'bypassPermissions',
    '--output-format',
    'json',
  ];

  let stdout: string;
  try {
    const running = exec('claude', args, { cwd: sandbox, env, maxBuffer: 64 * 1024 * 1024 });
    running.child.stdin?.end();
    ({ stdout } = await running);
  } catch (error) {
    const shell = error as { stdout?: string; stderr?: string; message?: string };
    const output = `${shell.stdout ?? ''}\n${shell.stderr ?? ''}`.trim();
    const fatal = fatalReason(output);
    if (fatal) throw new TrialHalted(fatal);
    throw new Error(`${shell.message ?? 'claude failed'}\n${output}`.trim());
  }

  const result = JSON.parse(stdout) as HeadlessResult;
  if (result.is_error) {
    const detail = `${result.result ?? 'unknown error'}${result.api_error_status ? ` (HTTP ${result.api_error_status})` : ''}`;
    const fatal = fatalReason(detail);
    if (fatal) throw new TrialHalted(fatal);
    throw new Error(detail);
  }
  return result;
}

export async function resetSandbox(sandbox: string): Promise<void> {
  await exec('git', ['reset', '--hard'], { cwd: sandbox });
  await exec('git', ['clean', '-fd'], { cwd: sandbox });
}

function transcriptFor(root: string, arm: Arm, sessionId: string): string | undefined {
  return globSync(join(armDir(root, arm), 'projects', '**', `${sessionId}.jsonl`))[0];
}

export interface TrialOptions {
  root: string;
  sandbox: string;
  model: string;
  repeats: number;
  prompts?: readonly TrialPrompt[];

  operator?: string;

  onRecord?: (record: RunRecord, remaining: number) => void;

  onFailure?: (plan: RunPlan, error: Error) => void;
}

export async function runTrial(options: TrialOptions): Promise<RunRecord[]> {
  const { root, sandbox, model, repeats } = options;
  const prompts = options.prompts ?? PROMPTS;
  await mkdir(root, { recursive: true });

  const plans = planRuns(prompts, repeats, model, await completedRuns(root));
  const records: RunRecord[] = [];

  for (const [position, plan] of plans.entries()) {
    const prompt = prompts.find((entry) => entry.id === plan.promptId);
    if (!prompt) throw new Error(`no prompt "${plan.promptId}"`);

    try {
      await resetSandbox(sandbox);
      const started = Date.now();
      const result = await headless(prompt.text, plan.arm, root, sandbox, model);
      const wallMs = Date.now() - started;

      const sessionId = result.session_id ?? '';
      const transcript = sessionId ? transcriptFor(root, plan.arm, sessionId) : undefined;
      if (!transcript) throw new Error(`no transcript for session "${sessionId}"`);

      const lines = (await readFile(transcript, 'utf8')).split('\n');
      const leaks = leaksIn(lines);
      const record: RunRecord = {
        ...plan,
        ...(options.operator ? { operator: options.operator } : {}),
        sessionId,
        transcript,
        costUsd: result.total_cost_usd ?? 0,
        numTurns: result.num_turns ?? 0,
        wallMs,
        leaks,
        admissible: admissible(plan.arm, leaks),
      };
      await appendFile(join(root, LEDGER), `${JSON.stringify(record)}\n`);
      records.push(record);
      options.onRecord?.(record, plans.length - position - 1);
    } catch (error) {
      if (error instanceof TrialHalted) throw error;

      options.onFailure?.(plan, error instanceof Error ? error : new Error(String(error)));
    }
  }

  await resetSandbox(sandbox);
  return records;
}
