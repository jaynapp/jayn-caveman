import { ANY_LANGUAGE } from '../effects/caveman/compliance.js';
import type { AnalysisReport } from '../effects/caveman/analyze.js';
import { styles, type Style } from './style.js';
import { table } from './table.js';

export interface RenderableAnalysis extends AnalysisReport {
  tokenMode?: string;
  holdout?: { holdoutRatio: number | null; samples: number };
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function renderProvenance(report: AnalysisReport): string[] {
  const { prior } = report.pFire;
  const tokens = report.pFireTokensBySource;
  const total = tokens.measured + tokens.prior + tokens.assumed;
  if (total === 0) return [];
  const borrowed = tokens.prior / total;

  const lines: string[] = [''];
  if (borrowed === 0) {
    lines.push(`  p_fire      ${pct(report.meanPFire)} token-weighted, measured on your own caveman turns`);
    return lines;
  }

  const label = borrowed >= 0.999 ? 'shipped prior' : `${pct(borrowed)} from the shipped prior`;
  const noCavemanTurns = !report.pFire.samples.some((sample) => sample.cavemanActive);
  lines.push(
    `  p_fire      ${label}${noCavemanTurns ? ' (no caveman sessions here)' : ''} — ` +
      `${pct(report.meanPFire)} token-weighted`,
  );
  if (prior) {
    const present = new Set<string>(report.pFire.samples.map((sample) => sample.language));
    const used = Object.entries(prior.level).filter(
      ([language]) => present.has(language) || (language === ANY_LANGUAGE && present.has('unknown')),
    );

    const DEEP = 100;
    for (const [language, level] of used.length > 0 ? used : Object.entries(prior.level)) {
      const at = (last: boolean, index: number) =>
        pct(1 / (1 + Math.exp(-(level.a + (last ? prior.c : 0) + prior.b * Math.log(1 + index)))));
      lines.push(
        `              ${(language === ANY_LANGUAGE ? 'any' : language).padEnd(4)}` +
          `${at(true, 0)} closing / ${at(false, 0)} mid-run at turn 0, ` +
          `${at(true, DEEP)} / ${at(false, DEEP)} by turn ${DEEP}` +
          (level.contributors === 1 ? '   [one contributor]' : ''),
      );
    }
    lines.push(
      `              composition band ${pct(prior.compositionRange[0])}-${pct(prior.compositionRange[1])}` +
        ` — that width is the estimate, see --audit`,
    );
    lines.push(`              fitted on ${prior.fittedOn.model}; another model family borrows this level`);
  }

  lines.push(
    borrowed >= 0.5
      ? '  This is a PROJECTION onto your sessions, not a measurement of them.'
      : `  The other ${pct(1 - borrowed)} is measured on your own caveman turns.`,
  );
  return lines;
}

export function renderAnalysis(
  report: RenderableAnalysis,
  options: { audit?: boolean; style?: Style; embedded?: boolean } = {},
): string {
  const { totals, effect, profile, counterCheck } = report;
  const s = options.style ?? styles();
  const lines: string[] = [];
  const label = (t: string) => t.padEnd(24);

  if (!s.enabled) {
    lines.push(`jayn-caveman — tool effect report (${effect.label})`);
    lines.push('='.repeat(64));
  } else if (options.embedded) {
    lines.push(s.gold(`Tool effect — ${effect.label}`));
  } else {
    lines.push(`${s.gradient('jayn-caveman')} ${s.dim(`— tool effect report (${effect.label})`)}`);
  }

  lines.push(
    `${s.dim(label('Sessions analysed:'))}${totals.sessions}  ${s.dim(`(${totals.sessionsWithTool} with ${effect.label})`)}`,
  );
  lines.push('');

  lines.push(
    `${s.dim(label('vanilla (no tools)'))}${s.dim(usd(totals.vanillaUSD))}   ${s.dim('<- baseline')}`,
  );

  if (totals.misconfiguredUSD > 0) {
    lines.push(
      `${s.dim(label('actual (tool correct)'))}${s.gradient(usd(totals.actualUSD))}   ` +
        s.dim('<- what savings are measured against'),
    );
    lines.push(`${s.dim(label('actually billed'))}${s.dim(usd(totals.paidUSD))}`);
  } else {
    lines.push(`${s.dim(label('actual (billed)'))}${s.gradient(usd(totals.actualUSD))}`);
  }
  lines.push(`${s.dim(label('optimized (tool on all)'))}${s.gradient(usd(totals.optimizedUSD))}`);
  lines.push('');
  lines.push(
    `${s.dim(label('saved'))}${s.gradient(usd(totals.savedUSD))}   ${s.dim(`${pct(totals.savedPct)} of bill`)}`,
  );
  lines.push(
    `${s.dim(label('still available'))}${s.gradient(usd(totals.availableUSD))}   ${s.dim(`${pct(totals.availablePct)} of bill`)}`,
  );

  if (totals.misconfiguredUSD > 0) {
    lines.push('');
    lines.push(
      s.flag(label('paid twice for nothing')) +
        usd(totals.misconfiguredUSD) +
        s.dim(`   ${pct(totals.misconfiguredUSD / totals.vanillaUSD)} of bill`),
    );
    lines.push(s.dim('  An injection was delivered more than once on the same turn — normally one hook'));
    lines.push(s.dim('  registered twice, e.g. in settings.json AND as an enabled plugin. That is config'));
    lines.push(
      s.dim(`  overhead, not ${effect.label}'s cost, so it is excluded from "saved" and shown here.`),
    );
  }

  const signs = new Set(report.sensitivity.map((s) => Math.sign(s.totals.savedUSD)));
  const indeterminate = signs.size > 1;

  if (report.pFireUnavailable) {
    lines.push('');
    lines.push('! p_fire could not be estimated here. Every turn above is priced as though caveman');
    lines.push('  fired on it, which it does not: measured elsewhere it reaches ~49% of prose');
    lines.push('  tokens. Read the saving as an UPPER BOUND.');
    if (report.pFire.registryRejected) {
      lines.push(`  Cause: the style registry was rejected (${report.pFire.registryRejected}),`);
      lines.push('  so its prior could not be borrowed either, and there are too few vanilla turns');
      lines.push('  here to fit one. Fix with: jayn-caveman compliance fit');
    } else {
      lines.push('  Cause: no registry to borrow a prior from, and too few vanilla turns here to');
      lines.push('  fit cutoffs of your own. Fix with: jayn-caveman compliance fit');
    }
  } else {
    for (const line of renderProvenance(report)) lines.push(line);
  }

  if (!options.audit) {
    if (indeterminate) {
      lines.push('');
      lines.push(s.flag('INDETERMINATE') + s.dim(': the sign flips inside the sensitivity band —'));
      lines.push(s.dim('      treat the headline as directionally unproven. See --audit.'));
    }
    return lines.join('\n');
  }

  const paint = (rows: string[]) => rows.map((r, i) => (i === 0 ? s.gold(r) : i === 1 ? s.dim(r) : r));

  lines.push('');
  lines.push(
    `${s.gold('Sensitivity to prose ratio')} ${s.dim(`(${effect.source} value: ${effect.proseRatio})`)}`,
  );
  lines.push(
    ...paint(
      table(
        ['scenario', 'vanilla', 'saved', 'saved %'],
        report.sensitivity.map((row) => [
          row.scenario.label,
          usd(row.totals.vanillaUSD),
          usd(row.totals.savedUSD),
          pct(row.totals.savedPct),
        ]),
      ),
    ),
  );

  lines.push('  the last two rows break the strata apart. R for mid-run turns has NO measurement');
  lines.push('  behind it and closing turns carry ~77% of prose tokens, so the row with the low');
  lines.push('  closing ratio is the one that moves the total.');
  if (indeterminate) {
    lines.push('');
    lines.push(s.flag('  INDETERMINATE') + s.dim(': the sign flips inside the sensitivity band.'));
    lines.push(s.dim('  Treat the headline as directionally unproven until the ratio is measured.'));
  }

  lines.push('');
  lines.push(s.gold('Audit'));
  if (report.tokenMode) lines.push(s.dim(`  prose counting        ${report.tokenMode}`));
  if (report.holdout) {
    lines.push(
      s.dim(
        `  held-out accuracy     ${
          report.holdout.holdoutRatio == null
            ? 'no ground-truth samples — using shipped priors, error unmeasured'
            : `${report.holdout.holdoutRatio.toFixed(3)} predicted/actual on ` +
              `${Math.floor(report.holdout.samples / 2)} held-out messages`
        }`,
      ),
    );
  }

  if (counterCheck.samples === 0) {
    lines.push(s.dim('  in-sample check       ') + s.flag('UNVERIFIED (no ground-truth samples)'));
  } else {
    const body = `${counterCheck.meanRatio.toFixed(3)} vs billed on ${counterCheck.samples} samples`;
    lines.push(
      s.dim(`  in-sample check       ${body}`) +
        (counterCheck.withinTolerance ? '' : s.flag('  <- OUT OF TOLERANCE')),
    );
  }
  const sum = (pick: (d: NonNullable<(typeof report.results)[number]['delta']>) => number) =>
    report.results.reduce((acc, r) => acc + (r.delta ? pick(r.delta) : 0), 0);
  lines.push(
    s.dim(
      `  prose share of bill   ${pct(report.proseShareOfBill)} (output side only — savings exceed ` +
        `this because prose also leaves the prefix)`,
    ),
  );
  lines.push(
    s.dim(
      `  savings decomposition output ${usd(Math.abs(sum((d) => d.outputUSD)))}, ` +
        `cache-write ${usd(Math.abs(sum((d) => d.writeUSD)))}, ` +
        `cache-read ${usd(Math.abs(sum((d) => d.readUSD)))}`,
    ),
  );
  lines.push(
    s.dim(
      `  injection profile     one-time ${Math.round(profile.oneTimeTokens)} tok, ` +
        `per-prompt ${Math.round(profile.perPromptTokens)} tok (from ${profile.sessions} sessions)`,
    ),
  );
  const measured = report.pFire.curve.pooled.filter((bin) => bin.pFire !== null).length;
  lines.push(
    `  p_fire applied        ${pct(report.meanPFire)} token-weighted over every priced turn ` +
      `(${measured}/${report.pFire.curve.pooled.length} bins measured` +
      `${report.pFire.borrowedCells > 0 ? `, ${report.pFire.borrowedCells} strata via the c shift` : ''})`,
  );
  const sourced = report.pFireTokensBySource;
  const sourceTotal = sourced.measured + sourced.prior + sourced.assumed;
  if (sourceTotal > 0) {
    lines.push(
      `  p_fire provenance     ${pct(sourced.measured / sourceTotal)} of prose tokens priced from your ` +
        `own turns, ${pct(sourced.prior / sourceTotal)} from the shipped prior` +
        (sourced.assumed > 0 ? `, ${pct(sourced.assumed / sourceTotal)} assumed to always fire` : ''),
    );
  }
  const prior = report.pFire.prior;
  if (prior) {
    lines.push(
      `  prior                 fitted on ${prior.fittedOn.model}, ${prior.fittedOn.onTurns} caveman-live ` +
        `turns from ${prior.fittedOn.contributors} contributor(s); b ${prior.b.toFixed(2)} ` +
        `[${prior.bCI[0].toFixed(2)}, ${prior.bCI[1].toFixed(2)}], c ${prior.c.toFixed(2)} ` +
        `[${prior.cCI[0].toFixed(2)}, ${prior.cCI[1].toFixed(2)}]`,
    );
    if (prior.binDisagreement) {
      const { cell, gap, measured: was, formula } = prior.binDisagreement;
      lines.push(
        `  prior vs bins         worst gap ${pct(gap)} at ${cell} ` +
          `(measured ${pct(was)}, formula ${pct(formula)})`,
      );
    }
  }
  if (report.pFire.registryRejected) {
    lines.push(`  style registry        REJECTED: ${report.pFire.registryRejected}`);
  }
  const negatives = report.results.filter((r) =>
    r.cavemanActive ? r.vanillaUSD < r.actualUSD : r.optimizedUSD > r.actualUSD,
  );
  if (negatives.length > 0) {
    lines.push(
      s.dim(
        `  net-negative sessions ${negatives.length}/${totals.sessions} — the one-time skill block ` +
          'does not amortise over a short session',
      ),
    );
  }

  lines.push('');
  lines.push(s.gold('Assumptions'));
  for (const line of [
    `  - prose ratio ${effect.proseRatio} is ${effect.source}; all figures scale with it`,
    '  - that ratio comes from 9 PAIRED runs, all ENGLISH, where the only difference',
    '    between arms was caveman, proven per run from the transcript injections. It',
    '    measures CLOSING turns. Every run was one headless prompt on one model with no',
    '    repeat, and headless sessions never reach the part of the decay curve where',
    '    compliance collapses — trial compliance was 9/9 against 45-72% on this corpus.',
    '    Non-English turns here are priced at that English ratio; nothing measured it',
    '  - on the three LONG trial prompts, the ones most like a real session, closing R',
    '    was 0.95. The headline is held down by short prompts and this corpus is not',
    '  - mid-run R is a pilot-informed placeholder, NOT a measurement: leave-one-out on',
    '    the pilot spanned 0.31 to 1.42, straddling 1.0, so expansion is not excluded.',
    '    The underlying turns averaged 2-4 prose tokens — see the two corner rows above',
    '  - p_fire LEVEL is not a measured compliance rate for any population: leaving one',
    '    contributor out of the control moves it across the composition band above, and',
    '    the corpus that moves it most holds 0% of the caveman-live turns — it is the',
    '    vanilla baseline every cutoff was fitted against. The SHAPE (position gap,',
    '    decay) survived every subset tested. `jayn-caveman compliance --root <dir>,<dir>` prints the width',
    '  - cutoffs and floors are keyed on MODEL FAMILY. Where your family has too little',
    '    vanilla writing behind it, a cross-model roll-up stands in and the turn is',
    '    judged against a bar other models set. `jayn-caveman compliance` counts those turns',
    '  - thinking tokens assumed unaffected, and this one was TRIED, not waved through:',
    '    transcripts store thinking as empty text, so it can only be had as a residual of',
    '    billed output minus visible text and tool args, which nothing validates. It',
    '    stays positive on all 9 English pairs and went negative on pairs of the wider',
    '    pilot. Thinking is ~89% of billed output here, so if caveman does move it,',
    '    everything above is understated by a lot. Nothing in reach measures it',
    '  - p/R inflation likely UNDER-estimates vanilla on turns where prose was suppressed',
  ]) {
    lines.push(s.dim(line));
  }

  const scored = report.pFire.samples.filter((sample) => sample.language !== 'unknown');
  const english = scored.filter((sample) => sample.language === 'en').length;
  if (scored.length > 0 && english / scored.length < 0.5) {
    lines.push(
      s.flag(
        `  - OUT OF DOMAIN: ${pct(1 - english / scored.length)} of scoreable turns here are not English.`,
      ),
    );
    lines.push(s.dim("    p_fire is measured on English output only; caveman's deletion rules name English"));
    lines.push(s.dim('    words and were observed not to fire on French at all. Do not read the number'));
    lines.push(s.dim('    above as a firing rate for this corpus.'));
  }
  const off = totals.sessions - totals.sessionsWithTool;
  if (off > 0) {
    lines.push(s.dim(`  - ${off} sessions lacked the tool; their injections are synthesised, not observed`));
  }

  return lines.join('\n');
}
