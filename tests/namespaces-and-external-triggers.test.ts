/**
 * Decision 0050, in process: case-folding namespaces (mongodb, elasticsearch),
 * `{{env.slug}}`, and upkeep triggers outside the worktree — resolution,
 * `{{main_worktree}}` across linked worktrees, and the safety bounds.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { makeDatastore, serverNamespace, type DsHandle } from '../src/drivers/datastores.js';
import { envSlug } from '../src/core/env-vars.js';
import { enumerateExternal, externalGlob, mainWorktreeOf } from '../src/core/external-triggers.js';
import { templateBakeKeys, triggerHash, triggerSet } from '../src/core/upkeep.js';
import type { Manifest } from '../src/core/manifest.js';
import { disposeStateSync } from './support/leaks.js';

const dirs: string[] = [];
const mk = (p: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) disposeStateSync(d);
});

const ENV = 'nova-parla-A8mQi2kG-e1';
const handle = (envId = ENV): DsHandle => {
  const root = mk('runly-ns-');
  return { envId, cwd: root, dataDir: join(root, 'data') };
};

describe('case-folding namespaces (mongodb, elasticsearch)', () => {
  it('lowercases and appends a hash of the original identity', () => {
    for (const driver of ['mongodb', 'elasticsearch'] as const) {
      const ds = makeDatastore('main', { driver, url: 'x://{{ns}}', ephemeral: driver === 'elasticsearch' }, 'stk');
      const ns = ds.ns(handle());
      expect(ns).toMatch(/^backlot_nova_parla_a8mqi2kg_e1_main_[0-9a-f]{8}$/);
      expect(ds.url(handle())).toBe(`x://${ns}`);
    }
  });

  it('keeps ids that differ only in case apart, and stays within 63 bytes', () => {
    const spec = { driver: 'mongodb' as const, url: '{{ns}}' };
    const a = makeDatastore('main', spec, 'stk').ns(handle('stack-AbC-e1'));
    const b = makeDatastore('main', spec, 'stk').ns(handle('stack-abc-e1'));
    const c = makeDatastore('main', spec, 'stk').ns(handle('stack-ABC-e1'));
    expect(new Set([a, b, c]).size).toBe(3);
    expect(b).toBe('backlot_stack_abc_e1_main'); // nothing folded: no suffix
    const long = makeDatastore('a_rather_long_datastore_name', spec, 'stk').ns(handle(`${'Very-Long-Stack-Name'.repeat(3)}-Xy12AbCd-e7`));
    expect(long.length).toBe(63);
    expect(long).toMatch(/^[a-z0-9_]+_[0-9a-f]{8}$/);
  });

  it('leaves every other server driver as it was', () => {
    expect(makeDatastore('main', { driver: 'postgres', url: '{{ns}}' }, 'stk').ns(handle())).toBe('backlot_nova_parla_A8mQi2kG_e1_main');
    expect(serverNamespace('backlot_Mixed_case')).toBe('backlot_Mixed_case');
    expect(serverNamespace('backlot_Mixed_case', true)).toMatch(/^backlot_mixed_case_[0-9a-f]{8}$/);
  });

  it('bakes lowercase template databases', async () => {
    process.env.BACKLOT_STATE_DIR = mk('runly-ns-state-');
    const h = handle();
    const log = join(h.cwd, 'calls.log');
    const ds = makeDatastore('main', {
      driver: 'mongodb',
      url: '{{ns}}',
      presets: ['hlt', 'demo'],
      create: `echo "create {{ns}} {{preset}}" >> "${log}"`,
      template_restore: `echo "restore {{template}} {{ns}}" >> "${log}"`,
      drop: `echo "drop {{ns}}" >> "${log}"`,
    }, 'nova-parla-A8mQi2kG');
    await ds.ensure(h, 'demo', false, false);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    const created = lines.find((l) => l.startsWith('create '))!.split(' ');
    expect(created[1]).toMatch(/^backlot_tpl_nova_parla_a8mqi2kg_demo_[0-9a-f]{8}_[0-9a-f]{8}$/);
    expect(created[2]).toBe('demo');
    expect(lines).toContain(`restore ${created[1]} ${ds.ns(h)}`);
  });
});

describe('{{env.slug}}', () => {
  it('is lowercase [a-z0-9-], deterministic, and distinct for case-only differences', () => {
    expect(envSlug(ENV)).toMatch(/^nova-parla-a8mqi2kg-e1-[0-9a-f]{8}$/);
    expect(envSlug(ENV)).toBe(envSlug(ENV));
    expect(envSlug('plain-stack-e1')).toBe('plain-stack-e1');
    expect(envSlug('a-AB-e1')).not.toBe(envSlug('a-ab-e1'));
    const long = envSlug(`${'Long_Name.'.repeat(10)}-e1`);
    expect(long.length).toBe(63);
    expect(long).toMatch(/^[a-z0-9-]+$/);
  });
});

const manifest = (...whens: string[]): Manifest => ({ name: 'ext', services: {}, upkeep: whens.map((when) => ({ when, run: '@rebake-template main' })) }) as Manifest;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' });

describe('upkeep triggers outside the worktree', () => {
  it('resolves ../, absolute, ~ and {{main_worktree}}; leaves worktree globs alone', () => {
    const base = mk('runly-ext-');
    const repo = join(base, 'repo');
    mkdirSync(repo);
    writeFileSync(join(repo, 'a'), 'a');
    git(repo, 'init', '-q');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'init');
    git(repo, 'worktree', 'add', '-q', '.worktree/feature', '-b', 'feature');
    const linked = join(repo, '.worktree', 'feature');
    expect(mainWorktreeOf(linked)).toBe(repo);
    expect(mainWorktreeOf(repo)).toBe(repo);
    expect(externalGlob(repo, 'src/**')).toBeNull();
    expect(externalGlob(repo, './pnpm-lock.yaml')).toBeNull();
    expect(externalGlob(repo, '../data/**')).toBe(join(base, 'data/**'));
    expect(externalGlob(linked, '../data/**')).toBe(join(repo, '.worktree', 'data/**'));
    expect(externalGlob(repo, '/srv/x/*.json')).toBe('/srv/x/*.json');
    expect(externalGlob(repo, '~/exports/**')).toBe(join(homedir(), 'exports/**'));
    // The committed form: the same directory from every worktree, however nested.
    expect(externalGlob(repo, '{{main_worktree}}/../data/**')).toBe(join(base, 'data/**'));
    expect(externalGlob(linked, '{{ main_worktree }}/../data/**')).toBe(join(base, 'data/**'));
    expect(() => externalGlob(repo, '{{env.id}}/x')).toThrow(/only \{\{main_worktree\}\}/);
  });

  it('hashes external files by absolute path, so linked worktrees share one template key', async () => {
    const base = mk('runly-ext-');
    const repo = join(base, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'export.json'), 'inside');
    git(repo, 'init', '-q');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'init');
    git(repo, 'worktree', 'add', '-q', '.worktree/feature', '-b', 'feature');
    const linked = join(repo, '.worktree', 'feature');
    mkdirSync(join(base, 'data', 'hlt', 'node_modules'), { recursive: true });
    writeFileSync(join(base, 'data', 'hlt', 'export.json'), 'v1');
    writeFileSync(join(base, 'data', 'hlt', 'node_modules', 'ignored.json'), 'x');
    const when = '{{main_worktree}}/../data/hlt/**';
    const m = manifest(when, '**/export.json');
    const set = await triggerSet(repo, m);
    expect(set.files).toEqual(['src/export.json', join(base, 'data', 'hlt', 'export.json')]);
    // A worktree glob never fires on an external file, and the other way round.
    expect(triggerHash(repo, set, '**/export.json')).toBe(triggerHash(repo, ['src/export.json'], '**/export.json'));
    const key = templateBakeKeys(manifest(when), repo, await triggerSet(repo, manifest(when)));
    expect(templateBakeKeys(manifest(when), linked, await triggerSet(linked, manifest(when)))).toEqual(key);
    writeFileSync(join(base, 'data', 'hlt', 'export.json'), 'v2');
    expect(templateBakeKeys(manifest(when), linked, await triggerSet(linked, manifest(when)))).not.toEqual(key);
  });

  it('refuses walks from /, the worktree or its ancestors, and caps the entries', async () => {
    const base = mk('runly-ext-');
    const wt = join(base, 'wt');
    mkdirSync(wt);
    await expect(enumerateExternal(wt, ['/**'])).rejects.toThrow(/filesystem root/);
    await expect(enumerateExternal(wt, ['../**'])).rejects.toThrow(/contains the worktree/);
    await expect(enumerateExternal(wt, [`${wt}/**`])).rejects.toThrow(/contains the worktree/);
    await expect(enumerateExternal(wt, ['../missing/**'])).resolves.toEqual([]);
    const big = join(base, 'big');
    mkdirSync(big);
    for (let i = 0; i < 30; i++) writeFileSync(join(big, `f${i}`), String(i));
    await expect(enumerateExternal(wt, ['../big/**'], 20)).rejects.toThrow(/more than 20 entries.*narrow the glob/);
    expect((await enumerateExternal(wt, ['../big/f1*'], 100)).map((f) => basename(f.path))).toEqual(['f1', 'f10', 'f11', 'f12', 'f13', 'f14', 'f15', 'f16', 'f17', 'f18', 'f19']);
    // A literal file outside the worktree.
    expect((await enumerateExternal(wt, ['../big/f3'])).map((f) => f.path)).toEqual([join(big, 'f3')]);
  });
});
