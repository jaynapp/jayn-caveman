import { mkdir, readFile, symlink, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ARMS = ['on', 'off'] as const;
export type Arm = (typeof ARMS)[number];

const ACTIVATE_HOOK = join(homedir(), '.claude', 'hooks', 'caveman-activate.js');
const TRACKER_HOOK = join(homedir(), '.claude', 'hooks', 'caveman-mode-tracker.js');
const STATUSLINE = join(homedir(), '.claude', 'hooks', 'caveman-statusline.sh');
const PLUGIN_ROOT = join(homedir(), '.claude', 'plugins');

const KEEP_FOREVER = 99999;

/**
 * Held identical across both arms, so the arms differ by `hooks` and nothing else.
 *
 * `model` and `effortLevel` are pinned rather than inherited because a config dir accumulates
 * whatever a session writes back into it, and the two arms drifted apart exactly that way once
 * already — ON carrying an `effortLevel` the control arm did not, on the outcome being measured.
 *
 * `statusLine` is here for a subtler reason. The activator appends a "STATUSLINE SETUP NEEDED …
 * proactively offer to set this up" block to its injection whenever $CLAUDE_CONFIG_DIR/settings.json
 * declares none. That block lands inside the treated arm's injection only, and it is an instruction
 * to write off-task prose — measured as caveman output, in an arm the control cannot match. Declaring
 * a statusLine silences the branch and makes the ON injection byte-identical to the corpus's.
 */
const FIXED = {
  cleanupPeriodDays: KEEP_FOREVER,
  model: 'claude-opus-5',
  effortLevel: 'high',
  statusLine: { type: 'command', command: `bash "${STATUSLINE}"` },
  enabledPlugins: {},
} as const;

export function armDir(root: string, arm: Arm): string {
  return join(root, 'arms', arm);
}

function settingsFor(arm: Arm, node: string): unknown {
  if (arm === 'off') return { ...FIXED, hooks: {} };
  const hook = (script: string) => ({
    hooks: [{ type: 'command', command: `"${node}" "${script}"`, timeout: 5 }],
  });
  return {
    ...FIXED,
    hooks: {
      SessionStart: [hook(ACTIVATE_HOOK)],
      UserPromptSubmit: [hook(TRACKER_HOOK)],
    },
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
