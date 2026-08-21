import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ANY_MODEL,
  ARM_IMBALANCE,
  armBalance,
  C_LAST,
  cellCompatibility,
  cellCoverage,
  cellPartsOf,
  coverageOf,
  creditCorpora,
  deserialiseThresholds,
  fitFloors,
  fitThresholds,
  floorsFrom,
  mergeThresholds,
  modelFamily,
  pFireByGroup,
  pFireByIndex,
  serialiseThresholds,
  TERSE_QUANTILE,
  terseness,
  type ArmBalance,
  type Bin,
  type Floors,
  type MergedThresholds,
  type PFireCurve,
  type Sample,
} from '../effects/caveman/compliance.js';
import { fitPrior, rowsFromSamples, summarisePrior } from '../effects/caveman/prior.js';
import {
  isUsableContributor,
  newBatchId,
  OBSERVATION_SCHEMA_VERSION,
  writeBatch,
  type StyleObservation,
} from '../effects/caveman/observations.js';
import { collectSamples } from '../effects/caveman/samples.js';
import { bandDefinitionSweep, leaveOneCorpusOut, type Composition } from '../effects/caveman/sensitivity.js';
import { readThresholdFile, THRESHOLD_PATH, writeThresholdFile } from '../effects/caveman/thresholds.js';
import { cliVersion } from '../version.js';
import { calibrateLocally, groupByLabel, loadGrouped } from '../transcript/load.js';
import type { Args, Command } from './args.js';
import { ROOT_HELP, targetsFrom, type Target } from './roots.js';

const SPEC = {
  value: ['root', 'thresholds', 'quantile', 'contributor', 'data', 'model'],
  boolean: ['consent', 'by-position'],
} as const;

const USAGE = `jayn-caveman compliance [fit] — how often caveman is actually in effect (p_fire)

${ROOT_HELP}
  --thresholds <file> style thresholds to borrow (default: the shipped curve, fitted at 0.25)
  --quantile <q>      vanilla quantile counting as terse (default: 0.25). Off the default this
                      is a sensitivity sweep: cells, floors and prior are refitted from this
                      corpus in-process, nothing is borrowed, nothing is written. It moves this
                      report only — the headline in \`analyze\` is always read at 0.25.
  --model <family>    restrict BOTH arms to one model family, e.g. claude-opus-5
  --by-position       split each curve into closing and mid-run turns (what the replay uses)

  record              export your transcripts as a contributable batch under data/caveman/
    --contributor <handle>  who the samples come from (required, not verified)
    --consent               affirm you are willing to publish them (required)
    --data <dir>            where to write (default: ./data)

  fit                 refit the shipped thresholds from the transcripts under --root
  <dir>               a transcript directory, same as a single --root

caveman's effect on a bill is two numbers, not one:

    effective_ratio = p_fire * R_compressed + (1 - p_fire) * 1.0

R_compressed needs both answers to the same prompt and cannot be recovered from a transcript
holding only one. p_fire can. This command measures p_fire and nothing else.

A turn counts as caveman-style when its sentence length falls below the 25th percentile of
VANILLA turns of the same language, size band and structural shape. Vanilla turns therefore
trip the detector 25% of the time by construction; that floor is measured per bin and
subtracted, never assumed to be zero. Sensitivity is unknown and taken as 1, so every figure
printed is a LOWER bound.

Sweeping --quantile is the sensitivity check on that 0.25: were the detector perfect the
estimate would not move at all, so how much it moves is how loose the bound is. Measured, it
plateaus from 0.25 upward on well-sampled bins and collapses below it.

Cutoffs are fitted from your own vanilla turns where you have enough of them, and borrowed from
the shipped thresholds where you do not — someone who runs caveman in every session has no
baseline of their own, which is the normal case rather than an edge one.

A cutoff belongs to one MODEL FAMILY, with a roll-up across families to fall back on. Vanilla
terseness spans 28 points between families, and the arms here are 61 points apart on Opus 5, so
a cutoff pooled across families judges the treatment arm against a bar the control's other
models set. The ON/OFF model mix is printed above every curve for that reason.

Passing one directory per contributor prints one curve each, plus the leave-one-out spread
that is the honest width of the estimate:
  npm run cli -- compliance --root ~/corpora/alice,~/corpora/bob --by-position`;

const pct = (n: number | null) => (n === null || !Number.isFinite(n) ? '   .' : `${(n * 100).toFixed(0)}%`);

const WIDTH = 26;

function fit(label: string): string {
  return (label.length <= WIDTH ? label : `…${label.slice(label.length - WIDTH + 1)}`).padEnd(WIDTH);
}

function renderBins(label: string, bins: Bin[], onTurns: number): string {
  return (
    `  ${fit(label)} ${String(onTurns).padStart(5)} |${bins.map((b) => pct(b.pFire).padStart(6)).join('')}\n` +
    `  ${' '.repeat(32)}|${bins.map((b) => String(b.onTurns).padStart(6)).join('')}   <- ON turns`
  );
}

function renderStratum(label: string, bins: Bin[]): string {
  const cells = bins.map((b) => `${pct(b.pFire)}${b.method === 'shifted' ? '*' : ''}`.padStart(6)).join('');
  return `  ${fit(label)} ${' '.repeat(5)} |${cells}`;
}

function renderCurve(label: string, curve: PFireCurve, onTurns: number, byPosition: boolean): string {
  const lines = [renderBins(label, curve.pooled, onTurns)];
  if (!byPosition) return lines.join('\n');
  lines.push(renderStratum('  closing turns', curve.byPosition.closing));
  lines.push(renderStratum('  mid-run turns', curve.byPosition.midRun));
  lines.push(
    `  ${' '.repeat(32)}|${curve.pooled.map((b) => pct(b.closingShare).padStart(6)).join('')}   <- closing share`,
  );
  return lines.join('\n');
}

const pct1 = (n: number | null) => (n === null ? '    .' : `${(n * 100).toFixed(1)}%`);

function renderComposition(rows: Composition[]): string[] {
  const all = rows.find((row) => row.omitted === null);
  const dropped = rows.filter((row) => row.omitted !== null);
  if (!all || dropped.length === 0) return [];

  const lines = ['', '  COMPOSITION — token-weighted p_fire over caveman-live prose', ''];
  lines.push(
    `    ${fit(`all ${dropped.length} corpora`)} ${' '.repeat(12)}${pct1(all.meanPFire).padStart(7)}`,
  );
  for (const row of dropped) {
    const share = `${(row.share * 100).toFixed(0)}% ON`;
    lines.push(
      `    ${fit(`without ${row.omitted}`)} ${row.language.padEnd(4)}${share.padStart(7)}` +
        `${pct1(row.meanPFire).padStart(8)}`,
    );
  }

  const top = dropped[dropped.length - 1]!;
  const low = dropped[0]!;
  lines.push('');
  lines.push(
    `  That width — ${pct1(low.meanPFire)} to ${pct1(top.meanPFire)} — IS the estimate, not a robustness check that`,
  );
  lines.push('  passed. p_fire is a rate against a vanilla baseline, and the baseline is whoever');
  lines.push('  happened to contribute; no amount of further turns from the same people narrows it.');

  if (low.share === 0) {
    lines.push('');
    lines.push(`  The bottom of the range is ${low.omitted}, which holds 0% of the caveman-live turns.`);
    lines.push('  It moves p_fire entirely through the control: the cutoffs and floors every ON');
    lines.push('  turn is scored against were fitted on its vanilla writing.');
  }
  if (top.language !== all.language) {
    lines.push('');
    lines.push(`  The top of the range is what you get WITHOUT the ${top.language} corpus, so these are`);
    lines.push(
      `  not two noisy draws: they are the ${all.language}-only estimate and the mixed-language one.`,
    );
    lines.push("  caveman's deletion rules name English words and were observed not to fire on");
    lines.push('  French at all, so on a mixed corpus this measures an instrument, not compliance.');
  }
  return lines;
}

function renderArms(balance: ArmBalance): string[] {
  if (balance.rows.length === 0) return [];
  const pctShare = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    `  ARM BALANCE — ${balance.onTurns} caveman-live turns, ${balance.offTurns} vanilla`,
    '',
    `    ${'model family'.padEnd(20)}${'ON'.padStart(8)}${'OFF'.padStart(8)}${'gap'.padStart(9)}`,
  ];
  for (const row of balance.rows) {
    const flag = Math.abs(row.gap) > ARM_IMBALANCE ? '  <-' : '';
    lines.push(
      `    ${row.model.padEnd(20)}${pctShare(row.onShare).padStart(8)}${pctShare(row.offShare).padStart(8)}` +
        `${`${row.gap >= 0 ? '+' : '−'}${(Math.abs(row.gap) * 100).toFixed(1)}pt`.padStart(9)}${flag}`,
    );
  }
  if (balance.imbalanced) {
    lines.push('');
    lines.push(
      `  ! The arms differ by ${(balance.worst * 100).toFixed(0)} points on model family. Vanilla terseness spans`,
    );
    lines.push('    28 points between families, so part of every rate below is a model contrast');
    lines.push('    rather than a caveman one. `--model <family>` restricts both arms and is the');
    lines.push('    only like-for-like read of this corpus.');
  }
  lines.push('');
  return lines;
}

function quantileFrom(args: Args): number {
  const raw = args.value('quantile');
  if (raw === undefined) return TERSE_QUANTILE;
  const value = Number(raw);

  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`--quantile must be strictly between 0 and 1, got "${raw}"`);
  }
  return value;
}

function restrictToModel(samples: readonly Sample[], family: string | undefined): Sample[] {
  if (family === undefined) return [...samples];
  const wanted = modelFamily(family);
  const kept = samples.filter((sample) => modelFamily(sample.model) === wanted);
  if (kept.length === 0) {
    const seen = [...new Set(samples.map((sample) => modelFamily(sample.model)))].sort();
    throw new Error(
      `no turns from model family "${family}" here.\n` +
        `Families in this corpus: ${seen.join(', ') || 'none'}`,
    );
  }
  return kept;
}

async function gather(selected: Target[]): Promise<{ all: Sample[]; groupOf: Map<Sample, string> }> {
  const byLabel = groupByLabel(await loadGrouped(selected), selected);
  const all: Sample[] = [];
  const groupOf = new Map<Sample, string>();

  for (const [label, sessions] of byLabel) {
    if (sessions.length === 0) {
      const target = selected.find((t) => t.label === label);
      console.error(`No transcripts under ${target?.roots.join(', ')}.`);
      continue;
    }

    const counter = calibrateLocally(sessions).counter;
    for (const sample of await collectSamples(sessions, counter)) {
      groupOf.set(sample, label);
      all.push(sample);
    }
  }
  return { all, groupOf };
}

const LEVEL = /Current level:\s*\*\*(\w+)\*\*/;

async function recordCommand(args: Args): Promise<void> {
  const selected = targetsFrom(args);
  if (selected.length > 1) {
    throw new Error(
      'record takes one directory at a time: a batch names one contributor, and several\n' +
        "roots would attribute everyone's writing to whoever ran the command.\n" +
        'Use --root <dir>, once per person.',
    );
  }

  const contributor = args.value('contributor');
  if (!isUsableContributor(contributor)) {
    throw new Error(
      '--contributor must name someone (a handle is fine, it is not verified).\n' +
        'It is the only record of whose writing a batch holds, and the data licence has\n' +
        'nothing else to attribute to.',
    );
  }
  if (!args.has('consent')) {
    throw new Error(
      'Pass --consent to confirm you are willing to publish this.\n\n' +
        'A batch holds, per assistant turn: language, size band, whether the turn was\n' +
        'bullet-shaped, its mean sentence length, its position in the session, and whether\n' +
        'caveman was live. No prose, no paths, no repo or project names, no timestamps, no\n' +
        'session ids. Nothing in it can be turned back into what you were working on — but it\n' +
        'does describe how you write, so the affirmation is explicit rather than implied.',
    );
  }

  const sessions = [...(await loadGrouped(selected)).keys()];
  const levels = new Set<string>();
  let cavemanSessions = 0;

  for (const session of sessions) {
    if (session.cavemanActive) cavemanSessions++;
    for (const turn of session.turns) {
      for (const block of turn.injectedOneTime) {
        const match = block.match(LEVEL);
        if (match) levels.add(match[1]!);
      }
    }
  }
  const samples =
    sessions.length === 0 ? [] : await collectSamples(sessions, calibrateLocally(sessions).counter);
  if (samples.length === 0) throw new Error('No scoreable turns found.');
  const sessionCount = sessions.length;

  const batch = newBatchId();
  const observations: StyleObservation[] = [];
  for (const sample of samples) {
    if (!Number.isFinite(sample.meanSentenceLength)) continue;
    const parts = cellPartsOf(sample);
    if (!parts) continue;
    observations.push({
      lang: parts.language,
      band: parts.band,
      shape: parts.shape,
      sentLen: sample.meanSentenceLength,
      index: sample.index,
      last: sample.lastOfRun,
      model: modelFamily(sample.model),
      caveman: sample.cavemanActive,
      batch,
    });
  }

  const dataRoot = args.valueOr('data', join(process.cwd(), 'data'));
  const written = await writeBatch(
    dataRoot,
    {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      batch,
      tool: 'caveman',
      harnessVersion: cliVersion(),
      measuredAt: new Date().toISOString(),
      contributor,
      sessions: sessionCount,
      cavemanSessions,
      levels: [...levels].sort(),
      consent: true,
    },
    observations,
  );

  const withCaveman = observations.filter((o) => o.caveman).length;
  console.log(written.jsonl);
  console.log(written.sidecar);
  console.log(
    `  ${observations.length} samples (${withCaveman} caveman, ${observations.length - withCaveman} vanilla) ` +
      `from ${sessionCount} sessions, ${cavemanSessions} with caveman live`,
  );
  console.log(`  levels seen: ${[...levels].sort().join(', ') || 'none'}`);
  console.log('');
  console.log('Refit the thresholds with:  jayn-caveman compliance fit');
}

async function fitCommand(args: Args): Promise<void> {
  const quantileAt = quantileFrom(args);
  const explicitThresholds = args.value('thresholds');

  // curves/ holds exactly one shipped curve, fitted at TERSE_QUANTILE. A curve at any other
  // quantile is a diagnostic, not an asset: `compliance --quantile <q>` refits one in-process,
  // so there is nothing to write and nothing to keep in sync.
  if (quantileAt !== TERSE_QUANTILE && explicitThresholds === undefined) {
    throw new Error(
      `fit writes the shipped curve, which is fitted at ${TERSE_QUANTILE}.\n` +
        `To sweep the cutoff, just report at it — the curve is refitted in-process:\n` +
        `  jayn-caveman compliance --quantile ${quantileAt}\n` +
        'To write a curve at this quantile anyway, name the file: --thresholds <file>',
    );
  }

  const { all, groupOf } = await gather(targetsFrom(args));
  const thresholds = fitThresholds(all, quantileAt);
  if (thresholds.cutoff.size === 0) throw new Error('No cell had enough vanilla turns to fit.');

  const vanillaByCorpus = new Map<string, number>();
  for (const sample of all) {
    if (sample.cavemanActive) continue;
    const label = groupOf.get(sample) ?? 'unknown';
    vanillaByCorpus.set(label, (vanillaByCorpus.get(label) ?? 0) + 1);
  }

  const floors = fitFloors(all, thresholds);

  const prior = fitPrior(
    rowsFromSamples(all, (sample) => groupOf.get(sample) ?? 'unknown'),
    thresholds,
    floorsFrom(floors),
    args.value('model'),
  );
  const path = explicitThresholds ?? THRESHOLD_PATH;
  await writeThresholdFile(
    serialiseThresholds(thresholds, creditCorpora(vanillaByCorpus), floors, quantileAt, prior),
    path,
  );
  console.log(`${path}`);
  console.log(
    `  ${thresholds.cutoff.size} cells fitted from ${all.filter((s) => !s.cavemanActive).length} vanilla turns`,
  );

  for (const [cell, cutoff] of [...thresholds.cutoff]
    .filter(([cell]) => cell.endsWith(`|${ANY_MODEL}`))
    .sort(([a], [b]) => a.localeCompare(b))) {
    console.log(
      `    ${cell.padEnd(18)} ${cutoff.toFixed(1).padStart(6)} words/sentence   n=${thresholds.support.get(cell)}`,
    );
  }
  console.log('');
  console.log(prior ? summarisePrior(prior) : '  no p_fire prior could be fitted from these corpora.');
  console.log('');

  const rollups = floors.filter((floor) => floor.model === ANY_MODEL);
  console.log(
    `  false-positive floor: ${floors.length} cells written ` +
      `(${floors.length - rollups.length} per model family), rolled up:`,
  );
  for (const floor of rollups) {
    console.log(
      `    bin ${floor.bin} ${floor.language} ${floor.position.padEnd(4)} ` +
        `${(floor.rate * 100).toFixed(0).padStart(3)}%   n=${floor.support}`,
    );
  }

  const coverage = cellCoverage(all, thresholds);
  const families = [...new Set(coverage.map((row) => row.model))];
  console.log('');
  console.log(
    `  GRID COVERAGE — ${coverage.filter((row) => row.fitted).length}/${coverage.length} cells ` +
      `over ${families.length - 1} model families + roll-up`,
  );
  console.log(`    ${'model family'.padEnd(20)}  fitted   vanilla   ON turns on the roll-up`);
  for (const model of families) {
    const rows = coverage.filter((row) => row.model === model);
    const onRollup = all.filter(
      (sample) =>
        sample.cavemanActive &&
        modelFamily(sample.model) === model &&
        terseness(sample, thresholds)?.exact === false,
    ).length;
    console.log(
      `    ${model.padEnd(20)}  ${String(rows.filter((row) => row.fitted).length).padStart(2)}/${rows.length}` +
        `${String(rows.reduce((total, row) => total + row.vanilla, 0)).padStart(10)}` +
        `${model === ANY_MODEL ? '' : String(onRollup).padStart(10)}`,
    );
  }

  const worth = coverage
    .filter((row) => !row.fitted && row.blocked > 0)
    .sort((a, b) => b.blocked - a.blocked);
  if (worth.length > 0) {
    console.log('');
    console.log('  Gaps worth closing, by caveman turns they would unblock:');
    for (const row of worth.slice(0, 12)) {
      console.log(
        `    ${row.cell.padEnd(30)} ${String(row.needed).padStart(3)} more vanilla turns -> ${row.blocked} scored`,
      );
    }
  }
}

function renderOrigin(thresholds: MergedThresholds): string {
  const local = [...thresholds.origin.values()].filter((o) => o === 'local').length;
  const shipped = thresholds.origin.size - local;
  return `${thresholds.cutoff.size} cells (${local} fitted locally, ${shipped} borrowed from the shipped set)`;
}

async function directoryOrNull(path: string): Promise<string | null> {
  try {
    return (await stat(path)).isDirectory() ? path : null;
  } catch {
    return null;
  }
}

async function run(args: Args): Promise<void> {
  const what = args.positionals[0];
  if (what === 'record') return recordCommand(args);
  if (what === 'fit') return fitCommand(args);

  const positional = what === undefined ? null : await directoryOrNull(what);
  if (what !== undefined && positional === null) {
    throw new Error(
      `unknown compliance subcommand "${what}" — expected \`record\`, \`fit\` or a transcript directory.\n` +
        'If you meant to pass flags through npm, they need a bare `--`:\n' +
        '  npm run cli -- compliance --root <dir>',
    );
  }

  const selected = targetsFrom(args, positional ?? undefined);
  const { all: everything, groupOf } = await gather(selected);
  if (everything.length === 0) {
    process.exitCode = 1;
    return;
  }

  const family = args.value('model');
  const all = restrictToModel(everything, family);
  const quantileAt = quantileFrom(args);
  const explicitThresholds = args.value('thresholds');

  // Cells, floors and prior are all functions of the quantile, so the shipped curve — fitted at
  // TERSE_QUANTILE — is unusable at any other one. A sweep refits all three from this corpus.
  const sweeping = quantileAt !== TERSE_QUANTILE && explicitThresholds === undefined;
  const thresholdsPath = explicitThresholds ?? THRESHOLD_PATH;
  const file = sweeping ? null : await readThresholdFile(thresholdsPath);

  const incompatible =
    file === null
      ? null
      : file.quantile !== quantileAt
        ? `fitted at quantile ${file.quantile}, not ${quantileAt}`
        : cellCompatibility(file).reason;
  const shipped = file !== null && incompatible === null ? deserialiseThresholds(file) : null;
  if (incompatible !== null) {
    console.error(`note: ${thresholdsPath} is ${incompatible}. Nothing is borrowed from it.`);
    console.error('      Refit it with `jayn-caveman compliance fit`.');
  }

  const thresholds = mergeThresholds(fitThresholds(all, quantileAt), shipped);
  const floors: Floors = sweeping
    ? floorsFrom(fitFloors(all, thresholds))
    : file !== null && incompatible === null
      ? floorsFrom(file.floors)
      : new Map();
  const onTurns = all.filter((s) => s.cavemanActive).length;
  const coverage = coverageOf(all, thresholds);

  console.log(
    `# p_fire — ${all.length} turns, ${onTurns} with caveman live` +
      (family ? `  [${modelFamily(family)} only]` : ''),
  );
  if (family) {
    console.log(`  restricted from ${everything.length} turns; both arms, so the contrast is like-for-like`);
  }
  console.log(`  thresholds: ${renderOrigin(thresholds)}`);
  if (sweeping) {
    console.log(`  sweep at quantile ${quantileAt}: cells, floors and prior all refitted here,`);
    console.log(`  nothing borrowed from the shipped ${TERSE_QUANTILE} curve.`);
  }
  console.log(
    `  scored ${coverage.scored}, unscored ${coverage.unscored} ` +
      `(${coverage.noSentence} with no prose sentence, ${coverage.noThreshold} with no covering cell)`,
  );
  if (coverage.borrowedCutoffs > 0) {
    console.log(
      `  ${coverage.borrowedCutoffs} scored turn(s) judged against the cross-model roll-up, ` +
        'their own family having no cutoff',
    );
  }
  if (sweeping) {
    console.log('');
    console.log(
      `! A sweep and the ${TERSE_QUANTILE} baseline do not score the same turns. The baseline borrows`,
    );
    console.log('  shipped cells this corpus cannot fit; a sweep has no curve at its quantile to borrow');
    console.log('  from, so it scores only what it fits locally. Read the movement as a bound on the');
    console.log('  cutoff choice, not a like-for-like delta — part of it is the narrower footprint.');
  }
  console.log('');

  for (const line of renderArms(armBalance(all))) console.log(line);

  if (coverage.scored === 0) {
    console.error('Nothing could be scored.');
    if (!shipped) {
      const flag = quantileAt === TERSE_QUANTILE ? '' : ` --quantile ${quantileAt}`;
      console.error(`No usable thresholds at ${thresholdsPath}, and too few vanilla turns here to fit one.`);
      console.error(`Fit them from a vanilla corpus first:  jayn-caveman compliance fit${flag}`);
    } else {
      console.error('Every turn fell outside the covered cells. Report this with the counts above.');
    }
    process.exitCode = 1;
    return;
  }

  const header = ['0-10', '10-20', '20-40', '40-80', '80+'].map((b) => b.padStart(6)).join('');
  console.log(`  ${'corpus (language)'.padEnd(WIDTH)} ${'nON'.padStart(5)} |${header}`);
  console.log(`  ${'-'.repeat(72)}`);

  const byPosition = args.has('by-position');
  const groups = pFireByGroup(all, thresholds, (sample) => groupOf.get(sample) ?? 'unknown', floors);
  for (const group of groups)
    console.log(renderCurve(`${group.label} (${group.language})`, group.curve, group.onTurns, byPosition));

  console.log(`  ${'-'.repeat(72)}`);
  const curve = pFireByIndex(all, thresholds, floors);
  const pooled = curve.pooled;
  console.log(renderCurve('POOLED', curve, onTurns, byPosition));

  console.log('');
  console.log('Lower bounds: the floor correction assumes the detector catches every firing turn.');
  console.log('Per-contributor rows are the result; the pooled row is a footnote. Measured so far,');
  console.log('one contributor decays from 86% to 3% across a session while another holds near 50%,');
  console.log('so a single pooled curve would assert an answer the data does not support.');

  const fitCurve = (subset: readonly Sample[]) =>
    pFireByIndex(subset, mergeThresholds(fitThresholds(subset, quantileAt), shipped), floors);
  const prior = sweeping
    ? fitPrior(
        rowsFromSamples(all, (sample) => groupOf.get(sample) ?? 'unknown'),
        thresholds,
        floors,
        family,
      )
    : file !== null && incompatible === null
      ? (file.pFire ?? null)
      : null;
  for (const line of renderComposition(
    leaveOneCorpusOut(all, (sample) => groupOf.get(sample) ?? 'unknown', fitCurve, prior),
  )) {
    console.log(line);
  }

  const bands = bandDefinitionSweep(all, fitCurve, prior);
  console.log('');
  console.log('  BAND DEFINITION — cells band on WORDS; banding on tokens would give');
  console.log('');
  console.log(`    ${' '.repeat(10)}${'closing'.padStart(9)}${'mid-run'.padStart(9)}`);
  for (const [label, at] of [
    ['words', bands.words],
    ['tokens', bands.tokens],
  ] as const) {
    console.log(
      `    ${label.padEnd(10)}${pct1(at.closing).padStart(9)}${pct1(at.midRun).padStart(9)}` +
        (label === 'words' ? '   <- shipped' : ''),
    );
  }
  console.log('');
  console.log('  Words wins on grounds the numbers cannot settle: BpeCounter is calibrated per');
  console.log('  model AND per person, so token bands let two people writing the same sentence be');
  console.log('  judged against different cutoffs. This row records the cost of that choice.');

  if (!byPosition) {
    console.log('');
    console.log('These rows pool closing turns with mid-run ones. They do not fire alike — a closing');
    console.log('turn runs 1.8 logits higher and carries ~9x the prose tokens — so the crude rate');
    console.log('above is not what the replay charges. `--by-position` prints the split it uses.');
  } else {
    const shifted = [...curve.byPosition.closing, ...curve.byPosition.midRun].filter(
      (b) => b.method === 'shifted',
    ).length;
    if (shifted > 0) {
      console.log('');
      console.log(`! ${shifted} stratum row(s) marked * were too thin to measure. They take this corpus's`);
      console.log(`  own pooled rate and only the position gap (c=${C_LAST}) from the shipped prior.`);
    }
  }

  const fallbacks = pooled.reduce((total, b) => total + b.floorFallbacks, 0);
  if (fallbacks > 0) {
    console.log('');
    console.log(`! ${fallbacks} ON turn(s) were charged a floor measured across all models, because no`);
    console.log('  vanilla turns exist for their own model family. Vanilla terseness spans 28 points');
    console.log('  between families, so that floor is approximate for them.');
  }

  const unfloored = pooled.reduce((total, b) => total + b.unfloored, 0);
  if (unfloored > 0) {
    console.log('');
    console.log(`! ${unfloored} ON turn(s) are excluded entirely: no floor exists for their language and`);
    console.log('  turn position, locally or in the shipped set, and charging them zero would invent one.');
  }

  const borrowedFloors = pooled.filter((b) => b.pFire !== null && b.floorOrigin !== 'local').length;
  if (borrowedFloors > 0) {
    console.log('');
    console.log(`! ${borrowedFloors} bin(s) used a borrowed false-positive floor: you have too few`);
    console.log('  vanilla turns at those turn positions to measure your own.');
  }

  const borrowed = [...thresholds.origin.values()].filter((o) => o === 'shipped').length;
  if (borrowed > 0) {
    console.log('');
    console.log(`! ${borrowed} cutoff(s) came from other people's vanilla writing, not yours.`);
    console.log('  Sentence length varies by author, so a borrowed cutoff carries their accent.');
  }

  const pooledCutoffs = [...thresholds.origin.values()].filter((o) => o === 'local').length;
  if (selected.length > 1 && pooledCutoffs > 0) {
    console.log('');
    console.log(
      `! ${pooledCutoffs} cutoff(s) and every floor were fitted across all ${selected.length} corpora`,
    );
    console.log('  together, not from any one of them. Contributors here differ by up to several');
    console.log('  words per sentence on the same cell, so a pooled cutoff describes nobody in');
    console.log('  particular. The per-contributor rows above are the result; this is the caveat.');
  }
  if (groups.length < 3) {
    console.log('');
    console.log(`! Only ${groups.length} contributor group(s) here. p_fire needs breadth, not depth:`);
    console.log('  target is >=5 people with >=10 caveman sessions each.');
  }
}

export const complianceCommand: Command = {
  name: 'compliance',
  summary: 'how often caveman actually fires (p_fire), per contributor and turn position',
  usage: USAGE,
  spec: SPEC,
  run,
};
