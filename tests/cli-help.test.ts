/**
 * `--help` / `-h` on any verb prints that verb's usage (from the one USAGE
 * text) and exits 0 without contacting the daemon. `runly reset-data --help`
 * used to answer "unknown flag '--help'" with exit 64.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { disposeStateSync } from './support/leaks.js';

const CLI = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js');
const state = mkdtempSync(join(tmpdir(), 'runly-help-'));
afterAll(() => disposeStateSync(state));

const runly = (...args: string[]): string =>
  execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, BACKLOT_STATE_DIR: state }, cwd: state });

describe('per-verb --help', () => {
  it('prints the usage of every listed verb for --help and -h', () => {
    const verbs = [...new Set([...runly('--help').matchAll(/^ {2}runly ([a-z][a-z-]*)/gm)].map((m) => m[1]!))];
    expect(verbs).toEqual(expect.arrayContaining(['up', 'reset-data', 'db', 'logs', 'exec', 'pool', 'daemon', 'preview']));
    for (const verb of verbs) {
      for (const flag of ['--help', '-h']) {
        const out = runly(verb, flag);
        expect(out, `${verb} ${flag}`).toMatch(new RegExp(`^Usage:\\n {2}runly ${verb}\\b`));
        // Only this verb's entries, not the whole text.
        expect(out.match(/^ {2}runly (\S+)/gm)!.every((l) => l === `  runly ${verb}`), `${verb} ${flag}`).toBe(true);
      }
    }
    expect(existsSync(join(state, 'daemon.pid'))).toBe(false);
  });

  it('narrows to a sub-verb, accepts flags around it, and answers `help <verb>`', () => {
    const reset = runly('reset-data', '--help');
    expect(reset).toContain('runly reset-data [--preset [DATASTORE=]NAME]...');
    expect(reset).not.toContain('runly up');
    expect(runly('reset-data', 'mongo', '--json', '-h')).toBe(reset);
    expect(runly('help', 'reset-data')).toBe(reset);
    const dbNew = runly('db', 'new', '--help');
    expect(dbNew).toContain('runly db new');
    expect(dbNew).not.toContain('runly db with');
    expect(runly('db', '--help')).toContain('runly db with');
    expect(runly('logs', '-f', '-h')).toContain('runly logs [service...]');
    expect(runly('exec', '--help')).toContain('runly exec <cmd...>');
  });
});
