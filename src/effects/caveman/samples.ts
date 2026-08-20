import { lastOfRunFlags, type SessionAnalysis } from '../../transcript/session.js';
import type { TokenCounter } from '../../transcript/tokens.js';
import type { Sample } from './compliance.js';
import { styleOf } from './style.js';

async function samplesOfSession(session: SessionAnalysis, counter: TokenCounter): Promise<Sample[]> {
  const lastOfRun = lastOfRunFlags(session.turns);
  const samples: Sample[] = [];
  for (const [position, turn] of session.turns.entries()) {
    const style = styleOf(turn.proseText);
    if (!style) continue;
    samples.push({
      ...style,
      tokens: await counter.count(turn.proseText, turn.model),
      index: turn.index,
      lastOfRun: lastOfRun[position]!,
      model: turn.model,

      cavemanActive: turn.cavemanLive,
    });
  }
  return samples;
}

export async function collectSamples(
  sessions: readonly SessionAnalysis[],
  counter: TokenCounter,
): Promise<Sample[]> {
  const samples: Sample[] = [];
  for (const session of sessions) samples.push(...(await samplesOfSession(session, counter)));
  return samples;
}
