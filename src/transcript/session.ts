import { readRawEvents, type RawEvent } from './events.js';

export interface Turn {
  index: number;

  id: string;
  model: string;
  timestamp: Date;

  proseText: string;

  onlyTextBlocks: boolean;

  hasToolUse: boolean;
  hasFence: boolean;
  outputTokens: number;
  inputTokens: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;

  injectedOneTime: string[];

  injectedPerTurn: string[];

  cavemanLive: boolean;

  userPromptsBefore: number;
}

export function lastOfRunFlags(turns: readonly Pick<Turn, 'userPromptsBefore'>[]): boolean[] {
  return turns.map((_turn, index) => index === turns.length - 1 || turns[index + 1]!.userPromptsBefore > 0);
}

export function markCavemanLive(turns: Turn[]): void {
  let live = false;
  for (const [index, turn] of turns.entries()) {
    if (index === 0 || turn.userPromptsBefore > 0) {
      live = turn.injectedPerTurn.length > 0 || turn.injectedOneTime.length > 0;
    }
    turn.cavemanLive = live;
  }
}

export interface SessionAnalysis {
  sessionId: string;
  file: string;
  cavemanActive: boolean;
  turns: Turn[];
}

const CAVEMAN_MARKER = 'CAVEMAN MODE ACTIVE';

const SKILL_BLOCK_MARKER = '## Persistence';

export function stripFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '');
}

function markerStrings(value: unknown, marker: string, found: Set<string>): void {
  if (typeof value === 'string') {
    if (value.includes(marker)) found.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) markerStrings(item, marker, found);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) markerStrings(item, marker, found);
  }
}

function injectionsIn(event: RawEvent): string[] {
  if (event.attachment?.hookName === undefined) return [];
  const found = new Set<string>();
  markerStrings(event.attachment, CAVEMAN_MARKER, found);
  return [...found];
}

function isUserPrompt(event: RawEvent): boolean {
  if (event.type !== 'user') return false;
  const content = event.message?.content;
  if (!Array.isArray(content)) return true;
  return !content.some((block) => block?.type === 'tool_result');
}

interface Draft {
  order: number;
  model: string;
  timestamp: Date;
  proseParts: string[];
  kinds: Set<string>;
  hasFence: boolean;
  outputTokens: number;
  inputTokens: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  usageSeen: boolean;
}

export async function analyzeSession(file: string): Promise<SessionAnalysis> {
  const drafts = new Map<string, Draft>();
  const order: string[] = [];
  let sessionId = 'unknown';
  let cavemanActive = false;

  let pendingOneTime: string[] = [];
  let pendingPerTurn: string[] = [];
  let pendingUserPrompts = 0;
  const attachedOneTime = new Map<string, string[]>();
  const attachedPerTurn = new Map<string, string[]>();
  const attachedPrompts = new Map<string, number>();

  for await (const event of readRawEvents(file)) {
    if (event.sessionId) sessionId = event.sessionId;

    for (const text of injectionsIn(event)) {
      cavemanActive = true;
      if (text.includes(SKILL_BLOCK_MARKER)) pendingOneTime.push(text);
      else pendingPerTurn.push(text);
    }
    if (isUserPrompt(event)) pendingUserPrompts++;

    if (event.type !== 'assistant') continue;
    const id = event.message?.id;
    if (!id) continue;

    let draft = drafts.get(id);
    if (!draft) {
      draft = {
        order: order.length,
        model: event.message?.model ?? '',
        timestamp: new Date(event.timestamp ?? Date.now()),
        proseParts: [],
        kinds: new Set(),
        hasFence: false,
        outputTokens: 0,
        inputTokens: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheRead: 0,
        usageSeen: false,
      };
      drafts.set(id, draft);
      order.push(id);

      attachedOneTime.set(id, pendingOneTime);
      attachedPerTurn.set(id, pendingPerTurn);
      attachedPrompts.set(id, pendingUserPrompts);
      pendingOneTime = [];
      pendingPerTurn = [];
      pendingUserPrompts = 0;
    }

    const usage = event.message?.usage;
    if (usage) {
      if (!draft.usageSeen || (usage.output_tokens ?? 0) > draft.outputTokens) {
        draft.outputTokens = usage.output_tokens ?? 0;
      }

      if (!draft.usageSeen) {
        draft.inputTokens = usage.input_tokens ?? 0;
        draft.cacheWrite5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
        draft.cacheWrite1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
        draft.cacheRead = usage.cache_read_input_tokens ?? 0;
      }
      draft.usageSeen = true;
      if (!draft.model) draft.model = event.message?.model ?? '';
    }

    for (const block of event.message?.content ?? []) {
      if (!block.type) continue;
      draft.kinds.add(block.type);
      if (block.type === 'text') {
        const text = (block as { text?: string }).text ?? '';
        if (text.includes('```')) draft.hasFence = true;
        draft.proseParts.push(stripFences(text));
      }
    }
  }

  const turns: Turn[] = order
    .map((id, index) => {
      const draft = drafts.get(id)!;
      return {
        index,
        id,
        model: draft.model,
        timestamp: draft.timestamp,
        proseText: draft.proseParts.join(''),
        onlyTextBlocks: draft.kinds.size === 1 && draft.kinds.has('text'),
        hasToolUse: draft.kinds.has('tool_use'),
        hasFence: draft.hasFence,
        outputTokens: draft.outputTokens,
        inputTokens: draft.inputTokens,
        cacheWrite5m: draft.cacheWrite5m,
        cacheWrite1h: draft.cacheWrite1h,
        cacheRead: draft.cacheRead,
        injectedOneTime: attachedOneTime.get(id) ?? [],
        injectedPerTurn: attachedPerTurn.get(id) ?? [],
        userPromptsBefore: attachedPrompts.get(id) ?? 0,
        cavemanLive: false,
      };
    })
    .filter((turn) => turn.outputTokens > 0);

  turns.forEach((turn, index) => {
    turn.index = index;
  });

  markCavemanLive(turns);

  return {
    sessionId,
    file,
    cavemanActive,
    turns,
  };
}
