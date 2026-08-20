import { detectLanguage, type Language } from '../effects/caveman/style.js';
import { observedCost } from '../transcript/replay.js';
import type { SessionAnalysis } from '../transcript/session.js';

export function billOf(sessions: readonly SessionAnalysis[]): number {
  return sessions.reduce((total, session) => total + observedCost(session.turns).costUSD, 0);
}

export interface Selection {
  kept: SessionAnalysis[];
  dropped: SessionAnalysis[];
  droppedUSD: number;
}

export function withoutCaveman(sessions: readonly SessionAnalysis[]): Selection {
  const kept: SessionAnalysis[] = [];
  const dropped: SessionAnalysis[] = [];
  for (const session of sessions) (session.cavemanActive ? dropped : kept).push(session);
  return { kept, dropped, droppedUSD: billOf(dropped) };
}

function languagesIn(session: SessionAnalysis): Set<Language> {
  const seen = new Set<Language>();
  for (const turn of session.turns) {
    const language = detectLanguage(turn.proseText);
    if (language !== 'unknown') seen.add(language);
  }
  return seen;
}

function isEnglishOnly(session: SessionAnalysis): boolean {
  const languages = languagesIn(session);
  return languages.size === 1 && languages.has('en');
}

export function englishOnly(sessions: readonly SessionAnalysis[]): Selection {
  const kept: SessionAnalysis[] = [];
  const dropped: SessionAnalysis[] = [];
  for (const session of sessions) (isEnglishOnly(session) ? kept : dropped).push(session);
  return { kept, dropped, droppedUSD: billOf(dropped) };
}
