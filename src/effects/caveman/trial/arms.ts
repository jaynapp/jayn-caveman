import { mkdir, readFile, symlink, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ARMS = ['on', 'off'] as const;
export type Arm = (typeof ARMS)[number];

const ACTIVATE_HOOK = join(homedir(), '.claude', 'hooks', 'caveman-activate.js');
const TRACKER_HOOK = join(homedir(), '.claude', 'hooks', 'caveman-mode-tracker.js');
const PLUGIN_ROOT = join(homedir(), '.claude', 'plugins');

const KEEP_FOREVER = 99999;

export function armDir(root: string, arm: Arm): string {
  return join(root, 'arms', arm);
}

function settingsFor(arm: Arm, node: string): unknown {
  if (arm === 'off') return { cleanupPeriodDays: KEEP_FOREVER, hooks: {}, enabledPlugins: {} };
  const hook = (script: string) => ({
    hooks: [{ type: 'command', command: `"${node}" "${script}"`, timeout: 5 }],
  });
  return {
    cleanupPeriodDays: KEEP_FOREVER,
    hooks: {
      SessionStart: [hook(ACTIVATE_HOOK)],
      UserPromptSubmit: [hook(TRACKER_HOOK)],
    },
    enabledPlugins: {},
  };
}

export async function buildArms(root: string, node: string = process.execPath): Promise<void> {
  for (const script of [ACTIVATE_HOOK, TRACKER_HOOK]) {
    await readFile(script, 'utf8').catch(() => {
      throw new Error(
        `caveman hook not found at ${script}\n` +
          'The ON arm is built from the same hooks the live sessions use, so the treatment in\n' +
          'the trial is the treatment in the corpus. Without them there is nothing to measure.',
      );
    });
  }
  for (const arm of ARMS) {
    const dir = armDir(root, arm);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'settings.json'), JSON.stringify(settingsFor(arm, node), null, 2));

    await rm(join(dir, 'plugins'), { force: true });
    await symlink(PLUGIN_ROOT, join(dir, 'plugins')).catch(() => undefined);
  }
}

export interface LeakReport {
  cavemanInjections: number;

  rtk: number;

  ctx: number;
}

const CAVEMAN_MARKER = 'CAVEMAN MODE ACTIVE';
const RTK_MARKER = 'RTK auto-rewrite';

const CTX_PREFIXES = ['mcp__plugin_context-mode', 'mcp__context-mode'];

export function leaksIn(lines: readonly string[]): LeakReport {
  const report: LeakReport = { cavemanInjections: 0, rtk: 0, ctx: 0 };
  for (const line of lines) {
    let event: {
      attachment?: { hookName?: unknown; toolUseID?: unknown; stdout?: unknown };
      message?: { content?: { type?: string; name?: string }[] };
    };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }

    const attachment = event.attachment;
    if (attachment?.hookName !== undefined && JSON.stringify(attachment).includes(CAVEMAN_MARKER)) {
      report.cavemanInjections++;
    }
    if (
      attachment?.toolUseID &&
      typeof attachment.stdout === 'string' &&
      attachment.stdout.includes(RTK_MARKER)
    ) {
      report.rtk++;
    }
    for (const block of event.message?.content ?? []) {
      if (block?.type === 'tool_use' && CTX_PREFIXES.some((prefix) => block.name?.startsWith(prefix))) {
        report.ctx++;
      }
    }
  }
  return report;
}

export function admissible(arm: Arm, leaks: LeakReport): boolean {
  if (leaks.rtk > 0 || leaks.ctx > 0) return false;
  return arm === 'on' ? leaks.cavemanInjections > 0 : leaks.cavemanInjections === 0;
}
