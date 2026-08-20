import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function cliVersion(): string {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const pkg: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const version = (pkg as { version?: unknown }).version;
    return typeof version === 'string' ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}
