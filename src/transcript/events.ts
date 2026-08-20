import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export interface RawEvent {
  type?: string;
  uuid?: string;
  sessionId?: string;

  attachment?: {
    type?: string;
    hookName?: string;
    hookEvent?: string;

    toolUseID?: string;
    content?: unknown;
    stdout?: unknown;
  };
  isSidechain?: boolean;
  cwd?: string;
  gitBranch?: string;
  timestamp?: string;
  message?: {
    id?: string;
    model?: string;
    role?: string;
    content?: Array<{
      type?: string;
      name?: string;
      id?: string;
      input?: { command?: string; [key: string]: unknown };
      tool_use_id?: string;
      content?: unknown;
    }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation?: {
        ephemeral_5m_input_tokens?: number;
        ephemeral_1h_input_tokens?: number;
      };
      server_tool_use?: {
        web_search_requests?: number;
        web_fetch_requests?: number;
      };
    };
  };
}

export async function* readRawEvents(file: string): AsyncGenerator<RawEvent> {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      yield JSON.parse(line) as RawEvent;
    } catch {
      continue;
    }
  }
}
