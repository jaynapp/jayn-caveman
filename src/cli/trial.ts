import { readFile } from 'node:fs/promises';
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
import { admissible, buildArms, leaksIn } from '../effects/caveman/trial/arms.js';
import { LANGS, PROMPTS, TIERS, type Lang, type Tier } from '../effects/caveman/trial/prompts.js';
import {
  CELLS,
  estimateCell,
  languageAgreement,
  sensitivityByCell,
  trialTurns,
  type Pair,
  type TrialTurn,
} from '../effects/caveman/trial/pair.js';
import {
  completedRuns,
  LEDGER,
  pairKey,
  planKey,
  planRuns,
  runTrial,
  TrialHalted,
  type RunRecord,
} from '../effects/caveman/trial/run.js';
import type { Args, Command } from './args.js';

const DEFAULT_MODEL = 'claude-opus-5';
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
  jayn-caveman trial init      --root <dir>
  jayn-caveman trial plan      [--repeats <n>] [--langs en,fr] [--tier <name>]
  jayn-caveman trial run       --root <dir> --sandbox <dir> [--model <id>] [--repeats <n>]
  jayn-caveman trial analyze   --root <dir>

  --root <dir>        where the arms, the ledger and the transcripts live
  --sandbox <dir>     the pinned worktree runs execute in (git worktree add … <sha>)
  --model <id>        held fixed across both arms (default: ${DEFAULT_MODEL})
  --repeats <n>       pairs per prompt per language (default: ${DEFAULT_REPEATS})
  --langs <a,b>       languages to run (default: ${LANGS.join(',')})
  --tier <name>       restrict to one tier: ${TIERS.join(', ')}
  --prompts <a,b>     restrict to named prompt ids

The model is fixed across arms deliberately. The corpus's one within-person contrast is ON
opus-5 against OFF opus-4-8, which is exactly why that person's numbers settle nothing.

Sizing: distinguishing R = 0.35 from R = 0.5 against ±25-35% within-person length noise needs
roughly 50-100 paired turns per cell, so 150-300 paired turns overall. Prioritise closing-tool
if the budget binds — it is the largest block and has no measurement at all today.`;

function selectedPrompts(args: Args) {
  const ids = args.list('prompts');
  const tier = args.value('tier') as Tier | undefined;
  if (tier && !TIERS.includes(tier)) throw new Error(`--tier must be one of ${TIERS.join(', ')}`);
  return PROMPTS.filter((prompt) => (!ids || ids.includes(prompt.id)) && (!tier || prompt.tier === tier));
}

function selectedLangs(args: Args): Lang[] {
  const raw = args.list('langs') ?? [...LANGS];
  for (const lang of raw) {
    if (!LANGS.includes(lang as Lang)) throw new Error(`--langs must be from ${LANGS.join(',')}`);
  }
  return raw as Lang[];
}

async function readLedger(root: string): Promise<RunRecord[]> {
  const text = await readFile(join(root, LEDGER), 'utf8').catch(() => {
    throw new Error(`no ${LEDGER} under ${root} — run \`jayn-caveman trial run\` first`);
  });
  const records: RunRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.trim()) records.push(JSON.parse(line) as RunRecord);
  }
  return records;
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
  for (const slot of byKey.values()) {
    if (!slot.on || !slot.off) {
      incomplete++;
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
      lang: slot.on.lang,
      model: slot.on.model,
      repeat: slot.on.repeat,
      on: await trialTurns(await analyzeSession(slot.on.transcript), counter),
      off: await trialTurns(await analyzeSession(slot.off.transcript), counter),
    });
  }
  return { pairs, inadmissible, incomplete, relabelled };
}

function fixed(value: number, places = 3): string {
  return Number.isFinite(value) ? value.toFixed(places) : '—';
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

async function analyze(root: string): Promise<void> {
  const records = await readLedger(root);
  const { pairs, inadmissible, incomplete, relabelled } = await pairsFrom(records);

  console.log(
    `pairs: ${pairs.length} usable, ${inadmissible} dropped on arm proof, ${incomplete} half-recorded` +
      (relabelled > 0 ? `, ${relabelled} re-judged against the ledger` : ''),
  );
  console.log(
    `cost:  $${records.reduce((total, r) => total + r.costUsd, 0).toFixed(2)} over ${records.length} runs`,
  );
  if (pairs.length === 0) return;

  console.log('');
  console.log('R — prose ON ÷ OFF, within a pair. 0.35 is what the tool assumes today.');
  console.log('Read the starred form: mass for closing cells, per-turn for mid-run.');
  console.log('');
  console.log('cell            form      pooled  median  IQR             pairs  drop  ON/OFF tok  turns');
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
          `${String(estimate.pairs).padStart(5)}  ${String(estimate.dropped).padStart(4)}  ` +
          (form === 'mass'
            ? `${String(estimate.onTokens).padStart(5)}/${String(estimate.offTokens).padEnd(5)}  ${estimate.onTurns}/${estimate.offTurns}`
            : ''),
      );
    }
  }
  console.log('');
  console.log('mass silently multiplies two things: prose-per-turn (what R means) by turn count');
  console.log('(how much work the agent did). Closing turns are one per run per arm, so the');
  console.log('counts cancel. mid-run has no such anchor — on this data one pair reported a mass');
  console.log('ratio of 5.49 whose per-turn ratio was 1.05, entirely because the ON arm took 21');
  console.log("mid-run turns to the OFF arm's 4. Dividing the count out is also why no pair has");
  console.log('to be excluded: turn count is affected BY the treatment, so dropping pairs whose');
  console.log('counts diverged selects on a post-treatment variable and biases what remains.');
  console.log('');
  console.log('unscorable is ON/OFF turns under the ten-word floor. Those turns are IN the ratio');
  console.log('above and OUT of the sensitivity below — dropping them is what broke the');
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

  console.log('');
  console.log('language agreement — did the model answer in the language it was asked in?');
  for (const lang of LANGS) {
    const inLang = pairs.filter((pair) => pair.lang === lang);
    if (inLang.length === 0) continue;
    let matched = 0;
    let total = 0;
    for (const pair of inLang) {
      const agreement = languageAgreement(pair, lang);
      matched += agreement.on + agreement.off;
      total += agreement.total;
    }
    console.log(
      `  ${lang}: ${matched}/${total} scorable turns (${fixed(total ? matched / total : Number.NaN, 2)})`,
    );
  }
  console.log('');
  console.log('A French arm that answered in English is not a French observation. Pooling the two');
  console.log('reproduces the Simpson’s paradox that inverted the corpus article comparison.');
}

export const trialCommand: Command = {
  name: 'trial',
  summary: "run the paired A/B that measures caveman's compression ratio",
  usage: USAGE,
  spec: {
    value: ['root', 'sandbox', 'model', 'repeats', 'langs', 'tier', 'prompts'],
    boolean: [],
  },
  async run(args: Args): Promise<void> {
    const action = args.positionals[0] ?? 'plan';
    const prompts = selectedPrompts(args);
    const langs = selectedLangs(args);
    const repeats = args.number('repeats', DEFAULT_REPEATS, (n) => Number.isInteger(n) && n > 0);

    const model = args.valueOr('model', DEFAULT_MODEL);

    if (action === 'plan') {
      const root = args.value('root');
      const done = root ? await completedRuns(root) : new Set<string>();
      const plans = planRuns(prompts, langs, repeats, model, done);
      const full = planRuns(prompts, langs, repeats, model).length;

      if (root) {
        console.log(`${plans.length} runs outstanding of ${full} — ${full - plans.length} already recorded`);
        for (const plan of plans) console.log(`  ${planKey(plan)}`);
      } else {
        console.log(`${plans.length} runs — ${plans.length / 2} pairs on ${model}`);
      }
      console.log(`langs: ${langs.join(', ')}   repeats: ${repeats}`);
      console.log('');
      console.log('tier      prompts  pairs  feeds');
      for (const tier of TIERS) {
        const inTier = prompts.filter((prompt) => prompt.tier === tier);
        if (inTier.length === 0) continue;
        const pairs = inTier.length * langs.length * repeats;
        console.log(
          `${tier.padEnd(8)}  ${String(inTier.length).padStart(7)}  ${String(pairs).padStart(5)}  ${TIER_FEEDS[tier]}`,
        );
      }
      console.log('');
      console.log('pairs per cell — the INDEPENDENT n, since turns inside one pair share a trajectory:');
      for (const [cell, tiers] of Object.entries(CELL_SOURCES) as [string, readonly Tier[]][]) {
        const pairs = prompts.filter((prompt) => tiers.includes(prompt.tier)).length * langs.length * repeats;
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
        langs,
        prompts,
        onRecord: (record, remaining) => {
          const proof = record.admissible ? 'ok' : 'ARM PROOF FAILED';
          console.log(
            `${record.promptId}/${record.lang}/${record.repeat}/${record.arm}  ` +
              `${record.numTurns} turns  $${record.costUsd.toFixed(3)}  ${(record.wallMs / 1000).toFixed(0)}s  ` +
              `${proof}  (${remaining} left)`,
          );
        },
        onFailure: (plan, error) => {
          console.log(
            `${plan.promptId}/${plan.lang}/${plan.repeat}/${plan.arm}  FAILED: ${error.message.split('\n')[0]}` +
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
      await analyze(root);
      return;
    }

    throw new Error(`unknown action "${action}" (init, plan, run, analyze)`);
  },
};
