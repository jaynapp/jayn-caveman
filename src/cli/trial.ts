import { spawn } from 'node:child_process';
import { globSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { analyzeSession } from '../transcript/session.js';
import { BpeCounter } from '../transcript/tokens.js';
import {
  deserialiseThresholds,
  terseness,
  type Sample,
  type Thresholds,
} from '../effects/caveman/compliance.js';
import { readThresholdFile } from '../effects/caveman/thresholds.js';
import { admissible, armDir, buildArms, leaksIn, type Arm } from '../effects/caveman/trial/arms.js';
import { PROMPTS, shard, TIERS, type Tier, type TrialPrompt } from '../effects/caveman/trial/prompts.js';
import {
  CELLS,
  estimateCell,
  sensitivityByCell,
  trialTurns,
  type Cell,
  type Pair,
  type TrialTurn,
} from '../effects/caveman/trial/pair.js';
import { importSessions, type Rejection } from '../effects/caveman/trial/import.js';
import {
  completedRuns,
  LEDGER,
  pairKey,
  planKey,
  planRuns,
  resetSandbox,
  runTrial,
  TrialHalted,
  type RunRecord,
} from '../effects/caveman/trial/run.js';
import type { Args, Command } from './args.js';

const DEFAULT_MODEL = 'claude-opus-5';
const DEFAULT_TRANSCRIPTS = join(homedir(), '.claude', 'projects');

/**
 * What an operator has to hold constant, printed on every sheet rather than kept in their head.
 *
 * These are not style rules. Each is a way an arm proof has already been broken: a second prompt
 * in one session changes what `lastOfRun` means, an edited prompt stops matching the key the
 * importer pairs on, and rtk or context-mode in either arm moves prose length by a path that is
 * not caveman.
 */
const SHEET_RULES = [
  'One prompt per session. Fresh session, paste, let it finish, close it.',
  'Do not edit the prompt text. The importer matches on it — an edited prompt is a lost run.',
  'Run every session in the same pinned sandbox checkout, not in your working tree.',
  'Turn rtk and context-mode OFF for both arms. Either one voids the run.',
  'Do not toggle caveman mid-session. The arm is read back from the injections.',
  'Follow the order below: the k-th ON session is paired with the k-th OFF session.',
];

function outstanding(
  prompts: readonly TrialPrompt[],
  repeats: number,
  model: string,
  done: ReadonlySet<string>,
) {
  return planRuns(prompts, repeats, model, done).map((plan) => ({
    plan,
    text: prompts.find((prompt) => prompt.id === plan.promptId)!.text,
  }));
}

function armLine(plan: { arm: string; promptId: string; repeat: number }): string {
  return `arm: ${plan.arm.toUpperCase().padEnd(3)}   ${plan.promptId}  repeat ${plan.repeat}`;
}
const DEFAULT_REPEATS = 3;

const TIER_FEEDS: Record<Tier, string> = {
  oneshot: 'closing-text — the cell that carried the pilot',
  short: 'closing-text, plus mid-run turns too short to price',
  long: 'mid-run in bulk; the pilot could not identify it',
};

const CELL_SOURCES: Record<string, readonly Tier[]> = {
  'closing-text': ['oneshot'],
  'closing-tool': ['short', 'long'],
  'mid-run': ['short', 'long'],
};

const CELL_PRIORITY: Record<string, string> = {
  'closing-text': 'FIRST PRIORITY — the only cell this instrument can measure',
  'closing-tool': 'skip — 0.4% of the corpus, 0 of 18 pilot pairs produced one',
  'mid-run': 'needs interactive capture; headless turns are too short to price',
};

const USAGE = `jayn-caveman trial — paired A/B measuring caveman's compression ratio

Usage:
  jayn-caveman trial sheet     --root <dir> [--repeats <n>] [--tier <name>] [--prompts <a,b>]
  jayn-caveman trial next      --root <dir> [--sandbox <dir>] [--repeats <n>]
  jayn-caveman trial import    --root <dir> [--from <dir>] [--since <date>] [--operator <who>]
  jayn-caveman trial init      --root <dir>
  jayn-caveman trial plan      [--repeats <n>] [--tier <name>]
  jayn-caveman trial run       --root <dir> --sandbox <dir> [--model <id>] [--repeats <n>]
  jayn-caveman trial analyze   --root <dir[,dir...]>

  --root <dir>        where the arms, the ledger and the transcripts live
  --from <dir>        transcripts to import hand-run sessions from
                      (default: ~/.claude/projects)
  --since <date>      ignore sessions started before this, e.g. 2026-08-20
  --sandbox <dir>     the pinned worktree runs execute in (git worktree add … <sha>)
                      on 'next', resets it and starts the session there itself, on the
                      arm the ledger asks for — the prompt is passed, never pasted
  --model <id>        held fixed across both arms (default: ${DEFAULT_MODEL})
  --repeats <n>       pairs per prompt (default: ${DEFAULT_REPEATS})
  --tier <name>       restrict to one tier: ${TIERS.join(', ')}
  --prompts <a,b>     restrict to named prompt ids
  --shard <k/n>       take shard k of n: prompts dealt within tier, so two operators run
                      disjoint prompts and no pair can straddle them
  --operator <who>    stamp runs with who produced them; analyze then refuses any pair
                      whose two arms carry different names
  --permission-mode   passed to the session on 'next' — hold it identical across operators

The model is fixed across arms deliberately. The corpus's one within-person contrast is ON
opus-5 against OFF opus-4-8, which is exactly why that person's numbers settle nothing.

Sizing: distinguishing R = 0.35 from R = 0.5 against ±25-35% within-person length noise needs
roughly 50-100 paired turns per cell, so 150-300 paired turns overall. Prioritise closing-tool
if the budget binds — it is the largest block and has no measurement at all today.`;

function selectedPrompts(args: Args) {
  const ids = args.list('prompts');
  const tier = args.value('tier') as Tier | undefined;
  if (tier && !TIERS.includes(tier)) throw new Error(`--tier must be one of ${TIERS.join(', ')}`);
  const chosen = PROMPTS.filter(
    (prompt) => (!ids || ids.includes(prompt.id)) && (!tier || prompt.tier === tier),
  );
  const spec = args.value('shard');
  return spec ? shard(chosen, spec) : chosen;
}

async function readLedger(root: string): Promise<RunRecord[]> {
  const text = await readFile(join(root, LEDGER), 'utf8').catch(() => {
    throw new Error(`no ${LEDGER} under ${root} — run \`jayn-caveman trial run\` first`);
  });
  const records: RunRecord[] = [];
  let foreign = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as RunRecord & { lang?: string };
    if (record.lang !== undefined && record.lang !== 'en') {
      foreign++;
      continue;
    }
    records.push({ ...record, transcript: transcriptUnder(root, record) });
  }
  if (foreign > 0) {
    console.log(`ledger: ${foreign} non-English runs from an older design skipped`);
  }
  return records;
}

function transcriptUnder(root: string, record: RunRecord): string {
  const copies = globSync(join(root, 'arms', record.arm, 'projects', '*', `${record.sessionId}.jsonl`));
  return copies.length === 1 ? copies[0]! : record.transcript;
}

async function proven(record: RunRecord): Promise<boolean> {
  const lines = (await readFile(record.transcript, 'utf8')).split('\n');
  return admissible(record.arm, leaksIn(lines));
}

async function pairsFrom(records: readonly RunRecord[]) {
  const counter = new BpeCounter();
  const byKey = new Map<string, Partial<Record<'on' | 'off', RunRecord>>>();
  for (const record of records) {
    const slot = byKey.get(pairKey(record)) ?? {};
    slot[record.arm] = record;
    byKey.set(pairKey(record), slot);
  }

  const pairs: Pair[] = [];
  let inadmissible = 0;
  let incomplete = 0;
  let relabelled = 0;
  let crossOperator = 0;
  for (const slot of byKey.values()) {
    if (!slot.on || !slot.off) {
      incomplete++;
      continue;
    }
    // A pair straddling two operators measures the operators as much as the arms: on the
    // interactive tiers the person picks the follow-ups and the approvals. Prompts are sharded
    // to keep that from happening; this is the check that the shard actually held. Runs recorded
    // before operators were tracked carry none, and pair as they always did.
    if (slot.on.operator && slot.off.operator && slot.on.operator !== slot.off.operator) {
      crossOperator++;
      continue;
    }
    const [onProven, offProven] = [await proven(slot.on), await proven(slot.off)];
    if (onProven !== slot.on.admissible || offProven !== slot.off.admissible) relabelled++;
    if (!onProven || !offProven) {
      inadmissible++;
      continue;
    }
    pairs.push({
      promptId: slot.on.promptId,
      model: slot.on.model,
      repeat: slot.on.repeat,
      on: await trialTurns(await analyzeSession(slot.on.transcript), counter),
      off: await trialTurns(await analyzeSession(slot.off.transcript), counter),
    });
  }
  return { pairs, inadmissible, incomplete, relabelled, crossOperator };
}

function fixed(value: number, places = 3): string {
  return Number.isFinite(value) ? value.toFixed(places) : '—';
}

function proseSummary(
  pairs: readonly Pair[],
  arm: Arm,
  cell: Cell,
): {
  turns: number;
  empty: number;
  tokens: number;
} {
  const turns = pairs.flatMap((pair) => pair[arm].filter((turn) => turn.cell === cell));
  return {
    turns: turns.length,
    empty: turns.filter((turn) => turn.tokens === 0).length,
    tokens: turns.reduce((total, turn) => total + turn.tokens, 0),
  };
}

function flagger(thresholds: Thresholds | null) {
  return (turn: TrialTurn): boolean | null => {
    if (!thresholds) return null;
    const sample: Sample = {
      language: turn.language,
      words: turn.words,
      meanSentenceLength: turn.meanSentenceLength,
      structureShare: turn.structureShare,
      tokens: turn.tokens,
      index: turn.index,
      lastOfRun: turn.cell !== 'mid-run',
      model: turn.model,
      cavemanActive: true,
    };
    return terseness(sample, thresholds)?.terse ?? null;
  };
}

async function sheet(
  root: string,
  prompts: readonly TrialPrompt[],
  repeats: number,
  model: string,
): Promise<void> {
  const cells = outstanding(prompts, repeats, model, await completedRuns(root));
  console.log(`${cells.length} sessions to run by hand — ${model}`);
  console.log('');
  for (const rule of SHEET_RULES) console.log(`  - ${rule}`);
  console.log('');
  const rule = '─'.repeat(78);
  for (const [position, cell] of cells.entries()) {
    console.log(`${String(position + 1).padStart(3)}/${cells.length}  ${armLine(cell.plan)}`);
    console.log(rule);
    console.log(cell.text);
    console.log(rule);
    console.log('');
  }
  console.log(`When a batch is done:  jayn-caveman trial import --root ${root}`);
}

/**
 * Start the next cell where it has to be started: the pinned sandbox, on the arm the ledger asks
 * for, with the prompt handed over as an argument rather than pasted.
 *
 * Every one of those was a way a run got lost by hand. A session started in the working tree
 * instead of the sandbox measures a different repository; a tree still dirty from the run before
 * measures a different one again; an arm picked from memory rather than from the ledger lands in
 * the wrong half of the pair; and an edited prompt no longer matches the key `import` pairs on.
 * None of them fail loudly — the transcript still imports, it just answers a different question.
 */
async function launch(
  root: string,
  sandbox: string,
  arm: Arm,
  prompt: string,
  model: string,
  permissionMode?: string,
): Promise<void> {
  await resetSandbox(sandbox);
  // Approving every tool call or reading each one is a free parameter of the operator, and on the
  // short and long tiers it decides how much the agent does before it writes its closing prose.
  // Two people running one design have to hold it at the same value, so it is a flag rather than
  // a habit.
  const flags = permissionMode ? ['--permission-mode', permissionMode] : [];
  const child = spawn('claude', ['--model', model, ...flags, prompt], {
    cwd: sandbox,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: armDir(root, arm),
      CAVEMAN_DEFAULT_MODE: arm === 'on' ? 'full' : 'off',
    },
    stdio: 'inherit',
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status) => resolve(status ?? 0));
  });
  console.log('');
  if (code !== 0) console.log(`claude exited ${code} — the run may be unusable`);
  console.log(`Record it:  jayn-caveman trial import --root ${root} --from ${join(root, 'arms')}`);
}

async function next(
  root: string,
  prompts: readonly TrialPrompt[],
  repeats: number,
  model: string,
  sandbox?: string,
  permissionMode?: string,
): Promise<void> {
  const cells = outstanding(prompts, repeats, model, await completedRuns(root));
  const cell = cells[0];
  if (!cell) {
    console.log('nothing outstanding — every cell in the design is recorded');
    return;
  }
  console.log(`${armLine(cell.plan)}   (${cells.length} left)`);
  console.log('─'.repeat(78));
  console.log(cell.text);
  console.log('─'.repeat(78));
  if (sandbox) {
    console.log(`sandbox: ${sandbox}   config: ${armDir(root, cell.plan.arm)}`);
    console.log('');
    await launch(root, sandbox, cell.plan.arm, cell.text, model, permissionMode);
  }
}

async function importRuns(
  root: string,
  from: string,
  since: Date | undefined,
  model: string,
  operator?: string,
): Promise<void> {
  const existing = await readLedger(root).catch(() => [] as RunRecord[]);
  const report = await importSessions({ from, existing, since, model, operator });

  console.log(`scanned ${report.scanned} transcripts under ${from}`);
  console.log(`${report.matched} matched a trial prompt`);

  const byReason = new Map<Rejection['reason'], Rejection[]>();
  for (const rejection of report.rejected) {
    byReason.set(rejection.reason, [...(byReason.get(rejection.reason) ?? []), rejection]);
  }
  for (const [reason, list] of byReason) {
    console.log(`  ${String(list.length).padStart(3)} ${reason}`);
    // A leak or a wrong model is something the operator can act on, so it is named rather than
    // counted into a total they can do nothing about.
    if (reason !== 'already recorded') for (const item of list) console.log(`        ${item.detail}`);
  }

  if (report.records.length === 0) {
    console.log('nothing new to record');
    return;
  }
  for (const record of report.records) {
    await appendFile(join(root, LEDGER), `${JSON.stringify(record)}\n`);
    console.log(
      `+ ${record.promptId}/${record.repeat}/${record.arm}  ${record.numTurns} turns  ` +
        `$${record.costUsd.toFixed(3)}  ${(record.wallMs / 1000).toFixed(0)}s`,
    );
  }
  console.log('');
  console.log(`${report.records.length} recorded. Analyse with: jayn-caveman trial analyze --root ${root}`);
}

async function analyze(roots: readonly string[]): Promise<void> {
  // Pair within each ledger before pooling. promptId/model/repeat is intentionally only unique
  // inside a participant's ledger, so flattening records first would overwrite valid pairs.
  const reports = await Promise.all(
    roots.map(async (root) => {
      const records = await readLedger(root);
      return { records, ...(await pairsFrom(records)) };
    }),
  );
  const records = reports.flatMap((report) => report.records);
  const pairs = reports.flatMap((report) => report.pairs);
  const inadmissible = reports.reduce((total, report) => total + report.inadmissible, 0);
  const incomplete = reports.reduce((total, report) => total + report.incomplete, 0);
  const relabelled = reports.reduce((total, report) => total + report.relabelled, 0);
  const crossOperator = reports.reduce((total, report) => total + report.crossOperator, 0);

  console.log(
    `ledgers: ${roots.length}; pairs: ${pairs.length} usable, ${inadmissible} dropped on arm proof, ${incomplete} half-recorded` +
      (relabelled > 0 ? `, ${relabelled} re-judged against the ledger` : '') +
      (crossOperator > 0 ? `, ${crossOperator} dropped for straddling two operators` : ''),
  );
  console.log(
    `cost:  $${records.reduce((total, r) => total + r.costUsd, 0).toFixed(2)} over ${records.length} runs`,
  );
  if (pairs.length === 0) return;

  console.log('');
  console.log('R — prose ON ÷ OFF, within a pair. English only. The tool ships 0.83 closing.');
  console.log('Read the starred form: mass for closing cells, per-turn for mid-run.');
  console.log('');
  console.log('cell            form      pooled  median  IQR             ratios  0-OFF  ON/OFF tok  turns');
  for (const cell of CELLS) {
    const estimate = estimateCell(pairs, cell);

    const authoritative = cell === 'mid-run' ? 'perTurn' : 'mass';
    for (const form of ['mass', 'perTurn'] as const) {
      const ratio = estimate[form];
      const iqr = `[${fixed(ratio.iqr[0], 2)}, ${fixed(ratio.iqr[1], 2)}]`;
      const star = form === authoritative ? '*' : ' ';
      console.log(
        `${(form === 'mass' ? cell : '').padEnd(14)}${star}${form.padEnd(8)}  ` +
          `${fixed(ratio.pooled).padStart(6)}  ${fixed(ratio.median).padStart(6)}  ${iqr.padEnd(14)}  ` +
          `${String(estimate.pairs).padStart(6)}  ${String(estimate.dropped).padStart(5)}  ` +
          (form === 'mass'
            ? `${String(estimate.onTokens).padStart(5)}/${String(estimate.offTokens).padEnd(5)}  ${estimate.onTurns}/${estimate.offTurns}`
            : ''),
      );
    }
  }
  console.log('Pooled R includes every pair; 0-OFF pairs have no finite individual ratio, so only');
  console.log('their median/IQR contribution is omitted.');
  const onMidRun = proseSummary(pairs, 'on', 'mid-run');
  const offMidRun = proseSummary(pairs, 'off', 'mid-run');
  console.log('');
  console.log('mid-run prose presence — zero-token turns are included in R; conditional means diagnose why.');
  console.log('arm  empty/all  empty rate  all-turn mean  non-empty mean');
  for (const [arm, summary] of [
    ['ON', onMidRun],
    ['OFF', offMidRun],
  ] as const) {
    const nonEmpty = summary.turns - summary.empty;
    console.log(
      `${arm.padEnd(3)}  ${String(summary.empty).padStart(5)}/${String(summary.turns).padEnd(3)}  ` +
        `${fixed(summary.empty / summary.turns).padStart(10)}  ` +
        `${fixed(summary.tokens / summary.turns).padStart(13)}  ` +
        `${fixed(summary.tokens / nonEmpty).padStart(14)}`,
    );
  }
  console.log('');
  console.log('mass silently multiplies two things: prose-per-turn (what R means) by turn count');
  console.log('(how much work the agent did). Closing turns are one per run per arm, so the');
  console.log('counts cancel. mid-run has no such anchor — on this data add-test-lastofrun');
  console.log('reported a mass ratio of 3.65 whose per-turn ratio was 1.83, entirely because the');
  console.log("ON arm took 8 mid-run turns to the OFF arm's 4. Dividing the count out is also");
  console.log('why no pair has to be excluded: turn count is affected BY the treatment, so');
  console.log('dropping pairs whose counts diverged selects on a post-treatment variable and');
  console.log('biases what remains — which is exactly how the French arm died.');
  console.log('');
  console.log('unscorable is ON/OFF turns under the ten-word floor. Including zero-token turns,');
  console.log('they are IN the ratio above and OUT of the sensitivity below — dropping them broke the');
  console.log('observational estimate, and they concentrate in mid-run.');

  const file = await readThresholdFile();
  const thresholds = file ? deserialiseThresholds(file) : null;
  console.log('');
  if (!thresholds) {
    console.log('detector sensitivity: no threshold registry found, so nothing to score against.');
  } else {
    console.log('detector sensitivity — share of KNOWN-treated turns the detector flags.');
    console.log('The tool assumes 1.000 everywhere, which is why every p_fire it prints is a bound.');
    console.log('cell           flagged  scorable   rate   hidden by floor');
    for (const row of sensitivityByCell(pairs, flagger(thresholds))) {
      console.log(
        `${row.cell.padEnd(13)}  ${String(row.flagged).padStart(7)}  ${String(row.scorable).padStart(8)}  ` +
          `${fixed(row.rate).padStart(5)}   ${row.unscorable}`,
      );
    }
  }
}

export const trialCommand: Command = {
  name: 'trial',
  summary: "run the paired A/B that measures caveman's compression ratio",
  usage: USAGE,
  spec: {
    value: [
      'root',
      'sandbox',
      'model',
      'repeats',
      'tier',
      'prompts',
      'from',
      'since',
      'shard',
      'operator',
      'permission-mode',
    ],
    boolean: [],
  },
  async run(args: Args): Promise<void> {
    const action = args.positionals[0] ?? 'plan';
    const prompts = selectedPrompts(args);
    const repeats = args.number('repeats', DEFAULT_REPEATS, (n) => Number.isInteger(n) && n > 0);

    const model = args.valueOr('model', DEFAULT_MODEL);

    if (action === 'plan') {
      const root = args.value('root');
      const done = root ? await completedRuns(root) : new Set<string>();
      const plans = planRuns(prompts, repeats, model, done);
      const full = planRuns(prompts, repeats, model).length;

      if (root) {
        console.log(`${plans.length} runs outstanding of ${full} — ${full - plans.length} already recorded`);
        for (const plan of plans) console.log(`  ${planKey(plan)}`);
      } else {
        console.log(`${plans.length} runs — ${plans.length / 2} pairs on ${model}`);
      }
      console.log(`repeats: ${repeats}   English only`);
      console.log('');
      console.log('tier      prompts  pairs  feeds');
      for (const tier of TIERS) {
        const inTier = prompts.filter((prompt) => prompt.tier === tier);
        if (inTier.length === 0) continue;
        const pairs = inTier.length * repeats;
        console.log(
          `${tier.padEnd(8)}  ${String(inTier.length).padStart(7)}  ${String(pairs).padStart(5)}  ${TIER_FEEDS[tier]}`,
        );
      }
      console.log('');
      console.log('pairs per cell — the INDEPENDENT n, since turns inside one pair share a trajectory:');
      for (const [cell, tiers] of Object.entries(CELL_SOURCES) as [string, readonly Tier[]][]) {
        const pairs = prompts.filter((prompt) => tiers.includes(prompt.tier)).length * repeats;
        const verdict = pairs >= 50 ? 'ok  ' : 'THIN';
        console.log(`  ${cell.padEnd(13)} ${String(pairs).padStart(3)}  ${verdict}  ${CELL_PRIORITY[cell]}`);
      }
      console.log('');
      console.log('The plan sizes on "50-100 paired TURNS per cell". A long pair contributes ~10');
      console.log('mid-run turns at once, so that unit flatters the count — those turns come from');
      console.log('one trajectory and are correlated. Pairs is the conservative reading, and the');
      console.log('pilot is what decides which one applies: it measures the within-pair spread.');
      console.log('');
      console.log('Arm order alternates between repeats, so anything drifting with wall-clock time');
      console.log('lands on both arms equally instead of on whichever one always went first.');
      return;
    }

    const root = args.required('root');

    if (action === 'sheet') {
      await sheet(root, prompts, repeats, model);
      return;
    }

    if (action === 'next') {
      await next(root, prompts, repeats, model, args.value('sandbox'), args.value('permission-mode'));
      return;
    }

    if (action === 'import') {
      const raw = args.value('since');
      const since = raw ? new Date(raw) : undefined;
      if (since && Number.isNaN(since.getTime())) throw new Error(`--since is not a date: "${raw}"`);
      await importRuns(root, args.value('from') ?? DEFAULT_TRANSCRIPTS, since, model, args.value('operator'));
      return;
    }

    if (action === 'init') {
      await buildArms(root);
      console.log(`arms built under ${root}/arms`);
      console.log('');
      console.log('Next, pin a sandbox to the commit the prompts were written against:');
      console.log('  git worktree add <sandbox> <sha> --detach');
      console.log(`  jayn-caveman trial run --root ${root} --sandbox <sandbox>`);
      return;
    }

    if (action === 'run') {
      const sandbox = args.required('sandbox');
      await buildArms(root);
      let halted: TrialHalted | null = null;
      const records = await runTrial({
        root,
        sandbox,
        model,
        repeats,
        operator: args.value('operator'),
        prompts,
        onRecord: (record, remaining) => {
          const proof = record.admissible ? 'ok' : 'ARM PROOF FAILED';
          console.log(
            `${record.promptId}/${record.repeat}/${record.arm}  ` +
              `${record.numTurns} turns  $${record.costUsd.toFixed(3)}  ${(record.wallMs / 1000).toFixed(0)}s  ` +
              `${proof}  (${remaining} left)`,
          );
        },
        onFailure: (plan, error) => {
          console.log(
            `${plan.promptId}/${plan.repeat}/${plan.arm}  FAILED: ${error.message.split('\n')[0]}` +
              ' — left unrecorded, a resume retries it',
          );
        },
      }).catch((error: unknown) => {
        if (!(error instanceof TrialHalted)) throw error;
        halted = error;
        return [] as RunRecord[];
      });
      console.log('');
      if (halted !== null) {
        console.log(`HALTED: ${(halted as TrialHalted).message}`);
        console.log('Retrying cannot fix this, so the remaining runs were not attempted.');
        console.log(`Everything already recorded is intact. Resume with the same command.`);
      }
      console.log(`${records.length} runs recorded this pass`);
      console.log(`analyse with: jayn-caveman trial analyze --root ${root}`);
      return;
    }

    if (action === 'analyze') {
      await analyze(
        root
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean),
      );
      return;
    }

    throw new Error(`unknown action "${action}" (init, plan, run, analyze)`);
  },
};
