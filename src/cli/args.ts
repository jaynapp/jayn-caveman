export interface FlagSpec {
  value?: readonly string[];

  boolean?: readonly string[];
}

export class Args {
  constructor(
    readonly positionals: readonly string[],
    private readonly flags: ReadonlyMap<string, string | true>,
  ) {}

  has(name: string): boolean {
    return this.flags.has(name);
  }

  value(name: string): string | undefined {
    const found = this.flags.get(name);
    return typeof found === 'string' ? found : undefined;
  }

  valueOr(name: string, fallback: string): string {
    return this.value(name) ?? fallback;
  }

  required(name: string): string {
    const found = this.value(name);
    if (found === undefined) throw new Error(`--${name} needs a value`);
    return found;
  }

  list(name: string): string[] | undefined {
    const raw = this.value(name);
    if (raw === undefined) return undefined;
    return raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  number(name: string, fallback: number, validate?: (n: number) => boolean): number {
    const raw = this.value(name);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || (validate && !validate(parsed))) {
      throw new Error(`--${name} needs a valid number, got "${raw}"`);
    }
    return parsed;
  }
}

export function parseArgs(argv: readonly string[], spec: FlagSpec = {}): Args {
  const valueFlags = new Set(spec.value ?? []);
  const booleanFlags = new Set(spec.boolean ?? []);
  const known = [...valueFlags, ...booleanFlags].sort();

  const positionals: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (booleanFlags.has(name)) {
      flags.set(name, true);
      continue;
    }
    if (valueFlags.has(name)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`--${name} needs a value`);
      flags.set(name, next);
      i++;
      continue;
    }
    throw new Error(`unknown flag "${arg}"${known.length > 0 ? ` (known: --${known.join(', --')})` : ''}`);
  }

  return new Args(positionals, flags);
}

export interface Command {
  name: string;

  summary: string;

  usage: string;
  spec: FlagSpec;
  run(args: Args): Promise<void>;
}
