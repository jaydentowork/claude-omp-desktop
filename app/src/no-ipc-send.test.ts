// Locked constraint 1 (issue #7): the hot stream path must never use
// ipcRenderer.send — MessageChannelMain + structured clone only. This test
// is the "grep in CI": it fails loud if the string creeps into src/.
//
// The single sanctioned ipcRenderer use is the preload's `.on('omp-port')`
// listener that receives the transferred MessagePort.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// vitest runs with cwd = app/, per package.json scripts.
const SRC_DIR = join(process.cwd(), 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe('locked constraint: no ipcRenderer.send on the stream path', () => {
  it('src/ contains no ipcRenderer.send call', () => {
    const offenders = walk(SRC_DIR).filter((file) =>
      readFileSync(file, 'utf8').includes('ipcRenderer.send'),
    );
    expect(offenders).toEqual([]);
  });
});
