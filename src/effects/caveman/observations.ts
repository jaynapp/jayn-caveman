import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { BANDS, LANGUAGES, SHAPES } from './compliance.js';

export const OBSERVATION_SCHEMA_VERSION = 2;

export interface StyleObservation {
  lang: (typeof LANGUAGES)[number];

  band: number;

  shape: (typeof SHAPES)[number];

  sentLen: number;

  index: number;

  last: boolean;

  model: string;

  caveman: boolean;

  batch: string;
}

export interface StyleBatchMeta {
  schemaVersion: number;
  batch: string;
  tool: 'caveman';

  harnessVersion: string;
  measuredAt: string;

  contributor: string;

  sessions: number;
  cavemanSessions: number;

  levels: string[];

  consent: true;
}

const PLACEHOLDER_CONTRIBUTORS = new Set([
  'unknown',
  'none',
  'n/a',
  'na',
  'anonymous',
  'me',
  'user',
  'root',
  'admin',
  'runner',
  'ubuntu',
  'vagrant',
  'docker',
]);

export function isUsableContributor(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && !PLACEHOLDER_CONTRIBUTORS.has(trimmed.toLowerCase());
}

const OBSERVATION_KEYS = new Set<keyof StyleObservation>([
  'lang',
  'band',
  'shape',
  'sentLen',
  'index',
  'last',
  'model',
  'caveman',
  'batch',
]);

const MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function parseObservation(line: string, where: string): StyleObservation {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error(`${where}: not valid JSON`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${where}: expected an object`);
  }

  const record = raw as Record<string, unknown>;
  const unknown = Object.keys(record).filter((k) => !OBSERVATION_KEYS.has(k as keyof StyleObservation));
  if (unknown.length > 0) {
    throw new Error(
      `${where}: unknown field(s) ${unknown.join(', ')}. A style sample carries shape and ` +
        'length only — no prose, no paths, no session ids, no timestamps.',
    );
  }

  if (!LANGUAGES.includes(record.lang as (typeof LANGUAGES)[number])) {
    throw new Error(`${where}: lang must be one of ${LANGUAGES.join(', ')}`);
  }
  if (!SHAPES.includes(record.shape as (typeof SHAPES)[number])) {
    throw new Error(`${where}: shape must be one of ${SHAPES.join(', ')}`);
  }
  if (
    !Number.isInteger(record.band) ||
    (record.band as number) < 0 ||
    (record.band as number) >= BANDS.length
  ) {
    throw new Error(`${where}: band must be an integer in 0..${BANDS.length - 1}`);
  }
  if (typeof record.sentLen !== 'number' || !Number.isFinite(record.sentLen) || record.sentLen <= 0) {
    throw new Error(`${where}: sentLen must be a positive finite number`);
  }
  if (!Number.isInteger(record.index) || (record.index as number) < 0) {
    throw new Error(`${where}: index must be a non-negative integer`);
  }
  if (typeof record.last !== 'boolean') throw new Error(`${where}: last must be a boolean`);
  if (typeof record.model !== 'string' || !MODEL_PATTERN.test(record.model)) {
    throw new Error(
      `${where}: model must be a model identifier — lowercase letters, digits, dots, dashes ` +
        'and underscores, at most 64 characters.',
    );
  }
  if (typeof record.caveman !== 'boolean') throw new Error(`${where}: caveman must be a boolean`);
  if (typeof record.batch !== 'string' || record.batch.length === 0) {
    throw new Error(`${where}: batch must be a non-empty string`);
  }

  return {
    lang: record.lang as (typeof LANGUAGES)[number],
    band: record.band as number,
    shape: record.shape as (typeof SHAPES)[number],
    sentLen: record.sentLen,
    index: record.index as number,
    last: record.last,
    model: record.model,
    caveman: record.caveman,
    batch: record.batch,
  };
}

const META_KEYS = new Set<keyof StyleBatchMeta>([
  'schemaVersion',
  'batch',
  'tool',
  'harnessVersion',
  'measuredAt',
  'contributor',
  'sessions',
  'cavemanSessions',
  'levels',
  'consent',
]);

export function parseBatchMeta(text: string, where: string): StyleBatchMeta {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${where}: not valid JSON`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${where}: expected an object`);
  }

  const record = raw as Record<string, unknown>;
  const unknown = Object.keys(record).filter((k) => !META_KEYS.has(k as keyof StyleBatchMeta));
  if (unknown.length > 0) {
    throw new Error(
      `${where}: unknown field(s) ${unknown.join(', ')}. A sidecar describes the contribution, ` +
        'not the work the transcripts were doing.',
    );
  }

  const str = (key: keyof StyleBatchMeta): string => {
    const value = record[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`${where}: ${key} must be a non-empty string`);
    }
    return value;
  };
  const count = (key: 'sessions' | 'cavemanSessions'): number => {
    const value = record[key];
    if (!Number.isInteger(value) || (value as number) < 0) {
      throw new Error(`${where}: ${key} must be a non-negative integer`);
    }
    return value as number;
  };

  if (typeof record.schemaVersion !== 'number' || !Number.isInteger(record.schemaVersion)) {
    throw new Error(`${where}: schemaVersion must be an integer`);
  }

  if (record.schemaVersion !== OBSERVATION_SCHEMA_VERSION) {
    throw new Error(
      `${where}: schemaVersion is ${record.schemaVersion}, this build reads ` +
        `${OBSERVATION_SCHEMA_VERSION}. The version moves when a sample MEANS something ` +
        'different, so pooling across it would average two definitions of one measurement. ' +
        'Re-record the batch with `jayn-caveman compliance record`.',
    );
  }
  if (record.tool !== 'caveman') throw new Error(`${where}: tool must be "caveman"`);
  if (record.consent !== true) {
    throw new Error(
      `${where}: consent must be true. These samples describe how a person writes, derived ` +
        'from their private transcripts, so the batch has to record that they agreed to publish it.',
    );
  }
  if (!isUsableContributor(record.contributor)) {
    throw new Error(
      `${where}: contributor must name someone. It is the only record of whose writing this is, ` +
        'and CC BY 4.0 attribution for the data has nothing else to point at.',
    );
  }
  if (!Array.isArray(record.levels) || record.levels.some((l) => typeof l !== 'string')) {
    throw new Error(`${where}: levels must be an array of strings`);
  }

  return {
    schemaVersion: record.schemaVersion,
    batch: str('batch'),
    tool: 'caveman',
    harnessVersion: str('harnessVersion'),
    measuredAt: str('measuredAt'),
    contributor: record.contributor,
    sessions: count('sessions'),
    cavemanSessions: count('cavemanSessions'),
    levels: record.levels as string[],
    consent: true,
  };
}

export function batchDir(dataRoot: string): string {
  return join(dataRoot, 'caveman');
}

export function newBatchId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const suffix = Math.random().toString(36).slice(2, 8);
  return `b${stamp}-${suffix}`;
}

export interface StyleBatch {
  meta: StyleBatchMeta;
  observations: StyleObservation[];
}

export async function writeBatch(
  dataRoot: string,
  meta: StyleBatchMeta,
  observations: StyleObservation[],
): Promise<{ jsonl: string; sidecar: string }> {
  const dir = batchDir(dataRoot);
  await mkdir(dir, { recursive: true });
  const jsonl = join(dir, `${meta.batch}.jsonl`);
  const sidecar = join(dir, `${meta.batch}.meta.json`);

  const body = observations
    .map((o) =>
      JSON.stringify({
        lang: o.lang,
        band: o.band,
        shape: o.shape,
        sentLen: Math.round(o.sentLen * 100) / 100,
        index: o.index,
        last: o.last,
        model: o.model,
        caveman: o.caveman,
        batch: o.batch,
      }),
    )
    .join('\n');
  await writeFile(jsonl, body.length > 0 ? `${body}\n` : '');
  await writeFile(sidecar, `${JSON.stringify(meta, null, 2)}\n`);
  return { jsonl, sidecar };
}

export async function readBatches(dataRoot: string): Promise<StyleBatch[]> {
  const dir = batchDir(dataRoot);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const batches: StyleBatch[] = [];
  for (const entry of entries.filter((e) => e.endsWith('.meta.json')).sort()) {
    const id = basename(entry, '.meta.json');
    const meta = parseBatchMeta(await readFile(join(dir, entry), 'utf8'), entry);
    if (meta.batch !== id) {
      throw new Error(`${entry}: sidecar claims batch "${meta.batch}", filename says "${id}"`);
    }

    const text = await readFile(join(dir, `${id}.jsonl`), 'utf8');
    const observations = text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line, index) => parseObservation(line, `${id}.jsonl:${index + 1}`));

    const wrong = observations.filter((o) => o.batch !== id);
    if (wrong.length > 0) {
      throw new Error(`${id}.jsonl: ${wrong.length} line(s) claim a different batch id`);
    }
    batches.push({ meta, observations });
  }
  return batches;
}
