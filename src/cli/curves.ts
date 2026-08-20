import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildThresholds, summariseBuild, thresholdsDiffer } from '../effects/caveman/build.js';
import { readBatches } from '../effects/caveman/observations.js';
import { readThresholdFile, thresholdPathIn } from '../effects/caveman/thresholds.js';
import type { Args, Command } from './args.js';

const SPEC = { value: ['data', 'curves'], boolean: ['check'] } as const;

const USAGE = `jayn-caveman curves — refit curves/ from every contributed batch in data/

  --data <dir>     observations directory (default: ./data)
  --curves <dir>   directory to write (default: ./curves)
  --check          fail if the committed file differs from a fresh build.
                   Writes nothing. This is the CI gate.

curves/ is generated; data/ is the asset. One append-only JSONL per contributed batch, so two
pull requests can never conflict and a bad batch is retracted by deleting one file.

Contribute a batch with: jayn-caveman compliance record --contributor <handle> --consent`;

async function run(args: Args): Promise<void> {
  const dataRoot = args.valueOr('data', join(process.cwd(), 'data'));
  const curvesRoot = args.valueOr('curves', join(process.cwd(), 'curves'));

  const batches = await readBatches(dataRoot);
  const path = thresholdPathIn(curvesRoot);
  const committed = await readThresholdFile(path);

  if (batches.length === 0 && committed === null) {
    console.log(`${path}: nothing measured and nothing committed.`);
    return;
  }

  const built = buildThresholds(batches, undefined, undefined, committed);

  if (args.has('check')) {
    const differs = committed === null || thresholdsDiffer(built, committed);
    console.log(`${path}: ${differs ? 'STALE' : 'up to date'}`);
    if (differs) process.exitCode = 1;
    return;
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(built, null, 2)}\n`);
  console.log(path);
  console.log(summariseBuild(built));
}

export const curvesCommand: Command = {
  name: 'curves',
  summary: 'refit the shipped thresholds from the contributed observations in data/',
  usage: USAGE,
  spec: SPEC,
  run,
};
