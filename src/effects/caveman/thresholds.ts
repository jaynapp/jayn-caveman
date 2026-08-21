import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ThresholdFile } from './compliance.js';

const CURVES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'curves');

export const THRESHOLD_FILENAME = 'caveman-style.json';

export const THRESHOLD_PATH = join(CURVES, THRESHOLD_FILENAME);

export function thresholdPathIn(curvesRoot: string): string {
  return join(curvesRoot, THRESHOLD_FILENAME);
}

export async function readThresholdFile(path = THRESHOLD_PATH): Promise<ThresholdFile | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as ThresholdFile;
  } catch {
    return null;
  }
}

export async function writeThresholdFile(file: ThresholdFile, path = THRESHOLD_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`);
}
