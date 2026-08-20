export const GOLD: readonly [number, number, number] = [0xeb, 0xbd, 0x50];

export const RAMP: readonly (readonly [number, number, number])[] = [
  [0x6b, 0x4f, 0x1d],
  [0x8d, 0x6b, 0x28],
  [0xc9, 0x99, 0x3a],
  [0xeb, 0xbd, 0x50],
  [0xf5, 0xce, 0x6b],
  [0xff, 0xe9, 0xa8],
];

const FLAG: readonly [number, number, number] = [0xb4, 0x53, 0x09];

export type Paint = (text: string) => string;

export interface Style {
  dim: Paint;

  gold: Paint;

  gradient: Paint;

  flag: Paint;

  enabled: boolean;
}

export interface StyleOptions {
  tty?: boolean;

  env?: NodeJS.ProcessEnv;
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value.length > 0 && value !== '0';
}

const fg = ([r, g, b]: readonly [number, number, number]) => `[38;2;${r};${g};${b}m`;
const RESET = '[0m';

function lerp(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

export function rampAt(t: number): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, t));
  const scaled = clamped * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(scaled));
  return lerp(RAMP[i]!, RAMP[i + 1]!, scaled - i);
}

export function colourEnabled(options: StyleOptions = {}): boolean {
  const env = options.env ?? process.env;
  if (isSet(env.FORCE_COLOR)) return true;
  if (isSet(env.NO_COLOR)) return false;
  if (env.TERM === 'dumb') return false;
  return options.tty ?? Boolean(process.stdout.isTTY);
}

const identity: Paint = (text) => text;

export function styles(options: StyleOptions = {}): Style {
  if (!colourEnabled(options)) {
    return { dim: identity, gold: identity, gradient: identity, flag: identity, enabled: false };
  }

  const paint = (colour: readonly [number, number, number]): Paint => {
    const open = fg(colour);
    return (text) => (text.length === 0 ? text : `${open}${text}${RESET}`);
  };

  return {
    dim: (text) => (text.length === 0 ? text : `[2m${text}${RESET}`),
    gold: paint(GOLD),
    flag: paint(FLAG),
    gradient: (text) => {
      if (text.length === 0) return text;

      const chars = [...text];
      const ink = chars.filter((c) => c !== ' ').length;
      if (ink === 0) return text;
      let seen = 0;
      let out = '';
      for (const ch of chars) {
        if (ch === ' ') {
          out += ch;
          continue;
        }

        const t = ink === 1 ? 1 : seen / (ink - 1);
        out += fg(rampAt(0.45 + 0.55 * t)) + ch;
        seen++;
      }
      return out + RESET;
    },
    enabled: true,
  };
}
