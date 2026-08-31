// toolSummary() heuristics — pins the Bash first-token rule from spec §2.5
// (`Bash  git status ›` shape, not the full command).

import { describe, expect, it } from 'vitest';
import { toolSummary } from '../transcript';

describe('toolSummary', () => {
  it('Bash: returns the first non-whitespace token of the command', () => {
    expect(toolSummary('bash', { command: 'git status' })).toBe('git');
    expect(toolSummary('Bash', { command: '   npm run test  --watch' })).toBe('npm');
    // Missing command falls back to the empty verb rather than `undefined`.
    expect(toolSummary('bash', {})).toBe('');
  });

  it('shell is the same alias', () => {
    expect(toolSummary('shell', { command: 'echo hi' })).toBe('echo');
  });

  it('Read/Write/Edit: path or file_path', () => {
    expect(toolSummary('Read', { path: 'src/main/transport.ts' })).toBe(
      'src/main/transport.ts',
    );
    expect(toolSummary('write', { file_path: 'README.md' })).toBe('README.md');
  });

  it('Grep/Search/Glob/Task fall back to first string-valued arg', () => {
    expect(toolSummary('Grep', { pattern: 'fn apply' })).toBe('fn apply');
    expect(toolSummary('Task', { description: 'Trace waveform pipeline' })).toBe(
      'Trace waveform pipeline',
    );
    expect(toolSummary('mystery', { foo: 'bar', n: 1 })).toBe('bar');
  });

  it('truncates long summaries with an ellipsis', () => {
    const long = 'x'.repeat(200);
    expect(toolSummary('Grep', { pattern: long })).toMatch(/…$/);
  });
});
