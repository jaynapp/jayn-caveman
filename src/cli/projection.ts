import { billOf, englishOnly, withoutCaveman } from '../corpus/profile.js';
import { analyze, type AnalysisReport } from '../effects/caveman/analyze.js';
import { CAVEMAN } from '../effects/caveman/effect.js';
import { calibrateLocally, groupByLabel, loadGrouped } from '../transcript/load.js';
import type { SessionAnalysis } from '../transcript/session.js';
import { ApiCounter, BpeCounter, resolveApiKey, type TokenCounter } from '../transcript/tokens.js';
import type { Args } from './args.js';
import type { Target } from './roots.js';

export interface Counting {
  counter: TokenCounter;
  mode: string;
  flush(): void;
}

export function counterFor(args: Args, sessions: SessionAnalysis[]): Counting {
  const local: BpeCounter = calibrateLocally(sessions).counter;
  if (!args.has('exact')) {
    return { counter: local, mode: 'offline (legacy BPE + calibration)', flush: () => {} };
  }

  const key = resolveApiKey();
  if (!key) {
    console.error('--exact needs ANTHROPIC_API_KEY; falling back to the offline counter.\n');
    return { counter: local, mode: 'offline (legacy BPE + calibration)', flush: () => {} };
  }

  const api = new ApiCounter(key);
  return { counter: api, mode: 'exact (count_tokens API)', flush: () => api.flush() };
}

export interface Cohort {
  label: string;
  sessions: SessionAnalysis[];
  billUSD: number;
  cavemanSessions: number;
  cavemanUSD: number;
  otherLanguageSessions: number;
  otherLanguageUSD: number;
}

export function cohortOf(label: string, sessions: SessionAnalysis[], english: boolean): Cohort {
  const clean = withoutCaveman(sessions);
  const selected = english ? englishOnly(clean.kept) : { kept: clean.kept, dropped: [], droppedUSD: 0 };
  return {
    label,
    sessions: selected.kept,
    billUSD: billOf(selected.kept),
    cavemanSessions: clean.dropped.length,
    cavemanUSD: clean.droppedUSD,
    otherLanguageSessions: selected.dropped.length,
    otherLanguageUSD: selected.droppedUSD,
  };
}

export async function cohorts(targets: Target[], english: boolean): Promise<Cohort[]> {
  const byLabel = groupByLabel(await loadGrouped(targets), targets);
  const found: Cohort[] = [];
  for (const [label, sessions] of byLabel) {
    if (sessions.length === 0) {
      const target = targets.find((entry) => entry.label === label);
      console.error(`No transcripts under ${target?.roots.join(', ')}.`);
      continue;
    }
    found.push(cohortOf(label, sessions, english));
  }
  return found;
}

export interface Projection {
  alwaysFires: AnalysisReport;
  measured: AnalysisReport;
}

export async function project(
  sessions: SessionAnalysis[],
  counter: TokenCounter,
  model: string | undefined,
): Promise<Projection> {
  return {
    alwaysFires: await analyze(sessions, counter, CAVEMAN, { model, alwaysFires: true }),
    measured: await analyze(sessions, counter, CAVEMAN, { model }),
  };
}
