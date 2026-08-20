import {
  ANY_MODEL,
  BANDS,
  binOf,
  CELL_VERSION,
  floorKey,
  floorsFrom,
  INDEX_BINS,
  LANGUAGES,
  MIN_CELL,
  quantile,
  SHAPES,
  TERSE_QUANTILE,
  type Cell,
  type FloorEntry,
  type ThresholdFile,
} from './compliance.js';
import type { StyleBatch, StyleObservation } from './observations.js';
import { fitPrior, rowsFromBatches, summarisePrior } from './prior.js';

const MIN_BIN = 10;

const cellKeys = (o: StyleObservation): Cell[] => [
  `${o.lang}|${o.band}|${o.shape}|${o.model}`,
  `${o.lang}|${o.band}|${o.shape}|${ANY_MODEL}`,
];

export interface BuiltCell {
  cutoff: number;
  support: number;

  pointsLost?: boolean;

  betweenBatch: { batches: number; cutoffs: number[]; spread: number | null };
}

export interface BuiltFloor extends FloorEntry {
  pointsLost?: boolean;
}

export interface BuiltThresholdFile extends Omit<ThresholdFile, 'cells' | 'floors'> {
  cells: Record<Cell, BuiltCell>;
  floors: BuiltFloor[];
}

export function buildThresholds(
  batches: readonly StyleBatch[],
  quantileAt: number = TERSE_QUANTILE,
  now = new Date(),
  committed: ThresholdFile | null = null,
): BuiltThresholdFile {
  const vanilla = batches.flatMap((b) => b.observations.filter((o) => !o.caveman));

  const pooled = new Map<Cell, number[]>();
  const perBatch = new Map<Cell, Map<string, number[]>>();
  for (const observation of vanilla) {
    for (const cell of cellKeys(observation)) {
      let values = pooled.get(cell);
      if (values === undefined) pooled.set(cell, (values = []));
      values.push(observation.sentLen);

      let byBatch = perBatch.get(cell);
      if (byBatch === undefined) perBatch.set(cell, (byBatch = new Map<string, number[]>()));
      let batchValues = byBatch.get(observation.batch);
      if (batchValues === undefined) byBatch.set(observation.batch, (batchValues = []));
      batchValues.push(observation.sentLen);
    }
  }

  const cells: Record<Cell, BuiltCell> = {};
  for (const [cell, values] of [...pooled].sort(([a], [b]) => a.localeCompare(b))) {
    if (values.length < MIN_CELL) continue;
    const cutoffs = [...(perBatch.get(cell) ?? new Map<string, number[]>())]
      .filter(([, batchValues]) => batchValues.length >= MIN_CELL)
      .map(([, batchValues]) => quantile(batchValues, quantileAt))
      .sort((a, b) => a - b);
    cells[cell] = {
      cutoff: quantile(values, quantileAt),
      support: values.length,
      betweenBatch: {
        batches: cutoffs.length,
        cutoffs,
        spread: cutoffs.length > 1 ? cutoffs[cutoffs.length - 1]! - cutoffs[0]! : null,
      },
    };
  }

  const carryable =
    committed !== null && committed.quantile === quantileAt && (committed.cellVersion ?? 1) === CELL_VERSION;

  if (committed !== null && carryable) {
    for (const [cell, entry] of Object.entries(committed.cells)) {
      if (cells[cell] !== undefined) continue;
      cells[cell] = {
        cutoff: entry.cutoff,
        support: entry.support,
        pointsLost: true,
        betweenBatch: { batches: 0, cutoffs: [], spread: null },
      };
    }
  }

  const tally = new Map<
    string,
    { entry: Omit<BuiltFloor, 'rate' | 'support'>; terse: number; total: number }
  >();
  for (const observation of vanilla) {
    const [own, rollup] = cellKeys(observation);
    const cell = cells[own!] ?? cells[rollup!];
    if (cell === undefined) continue;
    const bin = binOf(observation.index);
    if (bin < 0) continue;
    const [from, to] = INDEX_BINS[bin]!;
    for (const model of [observation.model, ANY_MODEL]) {
      const key = floorKey(bin, observation.lang, observation.last, model);
      let row = tally.get(key);
      if (row === undefined) {
        row = {
          entry: {
            bin,
            from,
            to: Number.isFinite(to) ? to : null,
            language: observation.lang,
            position: observation.last ? 'last' : 'mid',
            model,
          },
          terse: 0,
          total: 0,
        };
        tally.set(key, row);
      }
      row.total++;
      if (observation.sentLen < cell.cutoff) row.terse++;
    }
  }

  const floors: BuiltFloor[] = [...tally.values()]
    .filter((row) => row.total >= MIN_BIN)
    .map((row) => ({ ...row.entry, rate: row.terse / row.total, support: row.total }));

  if (committed !== null && carryable) {
    const present = new Set(floors.map((f) => floorKey(f.bin, f.language, f.position === 'last', f.model)));
    for (const floor of committed.floors) {
      if (!present.has(floorKey(floor.bin, floor.language, floor.position === 'last', floor.model))) {
        floors.push({ ...floor, pointsLost: true });
      }
    }
  }
  floors.sort(
    (a, b) =>
      a.bin - b.bin ||
      a.language.localeCompare(b.language) ||
      a.position.localeCompare(b.position) ||
      a.model.localeCompare(b.model),
  );

  const pFire = fitPrior(
    rowsFromBatches(batches),
    {
      cutoff: new Map(Object.entries(cells).map(([cell, entry]) => [cell, entry.cutoff])),
      support: new Map(Object.entries(cells).map(([cell, entry]) => [cell, entry.support])),
    },
    floorsFrom(floors),
  );

  return {
    cellVersion: CELL_VERSION,
    fittedAt: now.toISOString(),

    corpora: [...batches]
      .sort((a, b) => a.meta.batch.localeCompare(b.meta.batch))
      .map((batch, index) => ({
        id: `corpus-${String.fromCharCode(97 + index)}`,
        vanillaTurns: batch.observations.filter((o) => !o.caveman).length,
      })),
    quantile: quantileAt,
    cells,
    ...(pFire === null ? {} : { pFire }),
    floors,
  };
}

export function thresholdsDiffer(built: BuiltThresholdFile, committed: unknown): boolean {
  const strip = (file: unknown): string => {
    const clone = JSON.parse(JSON.stringify(file)) as Record<string, unknown>;
    delete clone.fittedAt;
    return JSON.stringify(clone);
  };
  return strip(built) !== strip(committed);
}

export function summariseBuild(built: BuiltThresholdFile): string {
  const entries = Object.entries(built.cells);
  const carried = entries.filter(([, entry]) => entry.pointsLost);

  const families = new Set(entries.map(([cell]) => cell.split('|')[3] ?? ANY_MODEL));
  const grid = LANGUAGES.length * BANDS.length * SHAPES.length;
  const total = families.size * grid;
  const lines = [
    `  ${entries.length}/${total} cells across ${families.size - 1} model families + roll-up ` +
      `(${entries.length - carried.length} fitted from ` +
      `${built.corpora.reduce((a, c) => a + c.vanillaTurns, 0)} vanilla samples across ` +
      `${built.corpora.length} batches, ${carried.length} carried over with no published points), ` +
      `at quantile ${built.quantile}`,
  ];
  if (built.pFire) lines.push(summarisePrior(built.pFire));
  else {
    lines.push('  no p_fire prior: no model family had caveman-live turns with both a cutoff and a floor.');
    lines.push('  A corpus with no caveman sessions will be priced as though it fired on every turn.');
  }
  if (carried.length > 0) {
    lines.push(
      `  ${carried.length} cutoff(s) predate the batch format and nobody can audit them. ` +
        'A contributed batch covering the same cell replaces one.',
    );
  }
  const carriedFloors = built.floors.filter((floor) => floor.pointsLost);
  if (carriedFloors.length > 0) {
    lines.push(
      `  ${carriedFloors.length} false-positive floor(s) carried from an earlier registry, on ` +
        `cell(s) ${[...new Set(carriedFloors.map((f) => `${f.from}+/${f.language}/${f.position}`))].join(', ')}. ` +
        'Every p_fire there is corrected against a rate no published sample measures.',
    );
  }

  const disputed = entries
    .filter(([, entry]) => entry.betweenBatch.spread !== null && entry.betweenBatch.spread > 2)
    .sort((a, b) => (b[1].betweenBatch.spread ?? 0) - (a[1].betweenBatch.spread ?? 0));
  if (disputed.length > 0) {
    lines.push('');
    lines.push('  cells where contributors write differently by more than 2 words/sentence:');
    for (const [cell, entry] of disputed.slice(0, 10)) {
      lines.push(
        `    ${cell.padEnd(16)} ${entry.betweenBatch.cutoffs.map((c) => c.toFixed(1)).join(' .. ')}` +
          `   spread ${entry.betweenBatch.spread?.toFixed(1)} over ${entry.betweenBatch.batches} batches`,
      );
    }
  }
  return lines.join('\n');
}
