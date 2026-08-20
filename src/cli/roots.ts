import { basename, resolve } from 'node:path';
import { DEFAULT_ROOT, type LoadTarget } from '../transcript/load.js';
import type { Args } from './args.js';

export type Target = LoadTarget & { roots: string[] };

export function labelFor(root: string): string {
  return basename(resolve(root)) || root;
}

export function targetsFrom(args: Args, positional?: string): Target[] {
  if (positional !== undefined) return [{ label: labelFor(positional), roots: [positional] }];
  const roots = args.list('root');
  if (roots === undefined) return [{ label: 'live', roots: [DEFAULT_ROOT] }];
  return roots.map((root) => ({ label: labelFor(root), roots: [root] }));
}

export const ROOT_HELP =
  '  --root <dir>,<dir>  one transcript directory per contributor group\n' +
  `                      (default: ${DEFAULT_ROOT})`;
