/**
 * Decision 0050, end to end through the built CLI and a real daemon: a
 * `mongodb` datastore with presets and a template, an `elasticsearch`
 * datastore `derived_from` it, `{{datastores.<ds>.preset}}` / `{{env.id}}` /
 * `{{env.slug}}` in a service, an `@rebake-template` trigger outside the
 * worktree, `db with`'s RUNLY_DB_PRESET and `pool doctor` over both `list:`
 * hooks. The servers are directories (as in cleanup.test.ts): a namespace is
 * a directory (mongodb) or files named `<prefix>-<index>` (elasticsearch), so
 * every assertion reads real state.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { makeCtx, type Ctx } from './support/context.js';
import { disposeStateSync } from './support/leaks.js';

const ctxs: Ctx[] = [];
const dirs: string[] = [];
afterAll(() => {
  for (const c of ctxs) c.dispose();
  for (const d of dirs) disposeStateSync(d);
});

const ECHO = `import { createServer } from 'node:http';
createServer((q, s) => s.end(JSON.stringify({ preset: process.env.PRESET, arg: process.argv[2], id: process.env.ENV_ID, slug: process.env.SLUG, search: process.env.SEARCH }))).listen(Number(process.env.PORT), '127.0.0.1');
`;

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'runly-mongo-es-')));
  dirs.push(root);
  const mongo = join(root, 'mongo');
  const es = join(root, 'es');
  const bakes = join(root, 'bakes.log');
  mkdirSync(mongo);
  mkdirSync(es);
  // The "export" in a sibling checkout: its content keys the mongo template.
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'runly-ext-data-')));
  dirs.push(data);
  mkdirSync(join(data, 'hlt'));
  writeFileSync(join(data, 'hlt', 'export.json'), '{"v":1}');
  const manifest = `name: mongo-es
services:
  web:
    run: node echo.mjs {{datastores.mongo.preset}}
    port: web
    env:
      PORT: "{{ports.web}}"
      PRESET: "{{datastores.mongo.preset}}"
      ENV_ID: "{{env.id}}"
      SLUG: "{{env.slug}}"
      SEARCH: "{{datastores.search.ns}}"
    ready: { http: /, timeout: 20 }
datastores:
  mongo:
    driver: mongodb
    url: "mongodb://127.0.0.1:47017/{{ns}}?replicaSet=rs0"
    presets: [hlt, demo]
    default_preset: hlt
    create: 'mkdir -p "${mongo}/{{ns}}" && echo {{preset}} > "${mongo}/{{ns}}/preset" && echo {{preset}} >> "${bakes}"'
    template_restore: 'cp -r "${mongo}/{{template}}" "${mongo}/{{ns}}"'
    drop: 'rm -rf "${mongo}/{{ns}}"'
    list: 'ls -1 "${mongo}"'
  search:
    driver: elasticsearch
    ephemeral: true
    derived_from: mongo
    url: "http://127.0.0.1:49200"
    drop: 'rm -f "${es}/{{ns}}" "${es}/{{ns}}"-* "${es}/{{ns}}".*'
    list: 'ls -1 "${es}"'
upkeep:
  - when: "{{main_worktree}}/../${basename(data)}/hlt/**"
    run: "@rebake-template mongo"
`;
  const c = makeCtx({ BACKLOT_SWEEP_MS: '600000' });
  ctxs.push(c);
  const wt = c.worktree({ 'runly.yml': manifest, 'echo.mjs': ECHO });
  const bakeCount = () => (existsSync(bakes) ? readFileSync(bakes, 'utf8').trim().split('\n').length : 0);
  const presetIn = (ns: string) => readFileSync(join(mongo, ns, 'preset'), 'utf8').trim();
  const web = async (url: string) => (await (await fetch(url)).json()) as { preset: string; arg: string; id: string; slug: string; search: string };
  return { c, wt, mongo, es, data, bakeCount, presetIn, web };
}

describe('mongodb + derived elasticsearch datastores (decision 0050)', () => {
  it('names, presets, derived flushes, env ids, external triggers, db with and pool doctor', async () => {
    const f = fixture();
    const { c, wt } = f;

    // A fresh environment: lowercase namespaces, the default preset, the env id.
    const up = await c.cli(['up', '--json'], wt);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    const envId: string = up.json.envId;
    expect(envId).toMatch(/[A-Z]|[a-z]/);
    const env = c.journal().allEnvs()[0]!;
    const mongoNs = env.datastoreNs.mongo!;
    const searchNs = env.datastoreNs.search!;
    for (const ns of [mongoNs, searchNs]) {
      expect(ns).toMatch(/^backlot_[a-z0-9_]+$/);
      expect(ns.length).toBeLessThanOrEqual(63);
    }
    expect(up.json.datastores.mongo.preset).toBe('hlt');
    expect(f.presetIn(mongoNs)).toBe('hlt');
    expect(f.bakeCount()).toBe(1);
    let seen = await f.web(up.json.urls.web);
    expect(seen).toMatchObject({ preset: 'hlt', arg: 'hlt', id: envId, search: searchNs });
    expect(seen.slug).toMatch(/^[a-z0-9-]{1,63}$/);
    expect(seen.slug.startsWith(envId.toLowerCase().replace(/[^a-z0-9-]/g, '-'))).toBe(true);

    // A preset reload of the source flushes the derived index and restarts its users.
    writeFileSync(join(f.es, `${searchNs}-hes_vorgang`), 'indexed');
    writeFileSync(join(f.es, `${searchNs}.hes.alias`), 'indexed');
    const demo = await c.cli(['up', '--preset', 'mongo=demo', '--json'], wt);
    expect(demo.code, demo.stderr + demo.stdout).toBe(0);
    expect([...demo.json.bindDiagnostics.reloaded].sort()).toEqual(['mongo', 'search']);
    expect(readdirSync(f.es)).toEqual([]);
    expect(f.presetIn(mongoNs)).toBe('demo');
    seen = await f.web(demo.json.urls.web);
    expect(seen).toMatchObject({ preset: 'demo', arg: 'demo', id: envId });

    // A reset keeps the held preset and flushes the index again; the template is reused.
    writeFileSync(join(f.es, `${searchNs}-hes_vorgang`), 'indexed');
    const reset = await c.cli(['reset-data', '--json'], wt);
    expect(reset.code, reset.stderr + reset.stdout).toBe(0);
    expect(readdirSync(f.es)).toEqual([]);
    expect(f.presetIn(mongoNs)).toBe('demo');
    expect((await f.web(reset.json.urls.web)).preset).toBe('demo');
    expect(f.bakeCount()).toBe(2);

    // Nothing changed: a plain up keeps the index (no reload, no flush).
    writeFileSync(join(f.es, `${searchNs}-hes_vorgang`), 'indexed');
    const same = await c.cli(['up', '--json'], wt);
    expect(same.code, same.stderr + same.stdout).toBe(0);
    expect(same.json.bindDiagnostics.reloaded).toEqual([]);
    expect(readdirSync(f.es)).toEqual([`${searchNs}-hes_vorgang`]);

    // The export outside the worktree changed: a new template is baked, the
    // store re-restored from it, and the derived index flushed.
    writeFileSync(join(f.data, 'hlt', 'export.json'), '{"v":2}');
    const rebaked = await c.cli(['up', '--json'], wt);
    expect(rebaked.code, rebaked.stderr + rebaked.stdout).toBe(0);
    expect(f.bakeCount()).toBe(3);
    expect(f.presetIn(mongoNs)).toBe('demo');
    expect(readdirSync(f.es)).toEqual([]);

    // db with: the copy's preset reaches the command.
    const dbWith = await c.cli(['db', 'with', 'mongo', '--preset', 'hlt', '--', 'sh', '-c', 'echo "P=$RUNLY_DB_PRESET D=$RUNLY_DB_DATABASE"'], wt);
    expect(dbWith.code, dbWith.stderr + dbWith.stdout).toBe(0);
    expect(dbWith.stdout).toMatch(/P=hlt D=backlot_[a-z0-9_]+/);

    // pool doctor over both list: hooks: lowercase orphans are runly's, a live
    // index under a referenced prefix is not an orphan, foreign names stay.
    const sid = env.stack.replace(/[^A-Za-z0-9_]/g, '_').toLowerCase();
    const mongoOrphan = `backlot_${sid}_e99_mongo_deadbeef`;
    const esOrphan = `backlot_${sid}_e99_search_deadbeef`;
    mkdirSync(join(f.mongo, mongoOrphan));
    mkdirSync(join(f.mongo, 'HLTDEV'));
    writeFileSync(join(f.es, `${esOrphan}-hes_vorgang`), 'x');
    writeFileSync(join(f.es, `${searchNs}-hes_vorgang`), 'live');
    writeFileSync(join(f.es, `${searchNs}_hes_other`), 'live');
    writeFileSync(join(f.es, 'hes.vorgang'), 'foreign');
    const dry = await c.cli(['pool', 'doctor', '--json'], wt);
    expect(dry.code, dry.stderr + dry.stdout).toBe(0);
    const found = (dry.json.findings as Array<{ kind: string; what: string }>).filter((x) => x.kind.endsWith('namespace')).map((x) => `${x.kind}:${x.what}`).sort();
    expect(found).toEqual([`namespace:${esOrphan}`, `namespace:${mongoOrphan}`].sort());
    const fix = await c.cli(['pool', 'doctor', '--fix', '--json'], wt);
    expect(fix.code, fix.stderr + fix.stdout).toBe(0);
    expect(existsSync(join(f.mongo, mongoOrphan))).toBe(false);
    expect(existsSync(join(f.mongo, 'HLTDEV'))).toBe(true);
    expect(existsSync(join(f.mongo, mongoNs))).toBe(true);
    expect(readdirSync(f.es).sort()).toEqual([`${searchNs}-hes_vorgang`, `${searchNs}_hes_other`, 'hes.vorgang'].sort());

    // Teardown drops both by their recorded recipes.
    const destroy = await c.cli(['destroy', '--json'], wt);
    expect(destroy.code, destroy.stderr + destroy.stdout).toBe(0);
    expect(existsSync(join(f.mongo, mongoNs))).toBe(false);
    expect(readdirSync(f.es).sort()).toEqual([`${searchNs}_hes_other`, 'hes.vorgang'].sort());
  }, 120_000);

  it('a datastore whose driver changes (mysql stand-in -> mongodb) is restored under its new name and the old one dropped; doctor knows mixed-case leftovers', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'runly-ns-move-')));
    dirs.push(root);
    const server = join(root, 'server');
    mkdirSync(server);
    const manifest = (driver: string) => `name: ns-move
services:
  web:
    run: node echo.mjs
    port: web
    env:
      PORT: "{{ports.web}}"
      PRESET: "{{datastores.Mongo.ns}}"
    ready: { http: /, timeout: 20 }
datastores:
  # A key with capitals: its stand-in namespace is mixed case whatever the
  # environment id hashes to, so the switch always moves it.
  Mongo:
    driver: ${driver}
    url: "mongodb://127.0.0.1:47017/{{ns}}"
    presets: [hlt, demo]
    create: 'mkdir -p "${server}/{{ns}}" && echo {{preset}} > "${server}/{{ns}}/preset"'
    template_restore: 'cp -r "${server}/{{template}}" "${server}/{{ns}}"'
    drop: 'rm -rf "${server}/{{ns}}"'
    list: 'ls -1 "${server}"'
`;
    const c = makeCtx({ BACKLOT_SWEEP_MS: '600000' });
    ctxs.push(c);
    const wt = c.worktree({ 'runly.yml': manifest('mysql'), 'echo.mjs': ECHO });
    const first = await c.cli(['up', '--preset', 'Mongo=demo', '--json'], wt);
    expect(first.code, first.stderr + first.stdout).toBe(0);
    const oldNs = c.journal().allEnvs()[0]!.datastoreNs.Mongo!;
    expect(oldNs).toMatch(/[A-Z]/); // the mixed-case name of the stand-in
    expect(existsSync(join(server, oldNs))).toBe(true);

    // The consumer switches to the real driver and runs `up`.
    writeFileSync(join(wt, 'runly.yml'), manifest('mongodb'));
    const moved = await c.cli(['up', '--json'], wt);
    expect(moved.code, moved.stderr + moved.stdout).toBe(0);
    const env = c.journal().allEnvs()[0]!;
    const newNs = env.datastoreNs.Mongo!;
    expect(newNs).not.toBe(oldNs);
    expect(newNs).toMatch(/^backlot_[a-z0-9_]+$/);
    // Restored under the new name, with the preset it held; the service sees it.
    expect(readFileSync(join(server, newNs, 'preset'), 'utf8').trim()).toBe('demo');
    expect(((await (await fetch(moved.json.urls.web)).json()) as { preset: string }).preset).toBe(newNs);
    // The old namespace is gone, and the recorded drop is the new one's.
    expect(existsSync(join(server, oldNs))).toBe(false);
    expect(env.dropRecipes?.Mongo?.ns).toBe(newNs);

    // A leftover of this stack in other case (a drop that failed back then)
    // is runly's for doctor, not foreign, and --fix removes it. Upper case
    // throughout, so the stack prefix itself differs in case.
    const leftover = `backlot_${env.stack.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}_E98_MONGO`;
    mkdirSync(join(server, leftover));
    const dry = await c.cli(['pool', 'doctor', '--json'], wt);
    expect(dry.code, dry.stderr + dry.stdout).toBe(0);
    const found = (dry.json.findings as Array<{ kind: string; what: string }>).filter((x) => x.kind.endsWith('namespace'));
    expect(found).toContainEqual(expect.objectContaining({ kind: 'namespace', what: leftover }));
    const fix = await c.cli(['pool', 'doctor', '--fix', '--json'], wt);
    expect(fix.code, fix.stderr + fix.stdout).toBe(0);
    expect(existsSync(join(server, leftover))).toBe(false);
    expect(existsSync(join(server, newNs))).toBe(true);
    const destroy = await c.cli(['destroy', '--json'], wt);
    expect(destroy.code, destroy.stderr + destroy.stdout).toBe(0);
    expect(readdirSync(server).filter((n) => !n.startsWith('backlot_tpl_'))).toEqual([]);
  }, 120_000);

  it('a wake that creates a missing source store flushes the store derived from it', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'runly-wake-derived-')));
    dirs.push(root);
    const server = join(root, 'server');
    const es = join(root, 'es');
    mkdirSync(server);
    mkdirSync(es);
    const manifest = (driver: string) => `name: wake-derived
services:
  web:
    run: node echo.mjs
    port: web
    idle: 1s
    env:
      PORT: "{{ports.web}}"
    ready: { http: /, timeout: 20 }
datastores:
  # Capitals in the key, as above: the switch always moves the namespace.
  Mongo:
    driver: ${driver}
    url: "mongodb://127.0.0.1:47017/{{ns}}"
    create: 'mkdir -p "${server}/{{ns}}"'
    drop: 'rm -rf "${server}/{{ns}}"'
  search:
    driver: elasticsearch
    ephemeral: true
    derived_from: Mongo
    url: "http://127.0.0.1:49200"
    drop: 'rm -f "${es}/{{ns}}"-*'
`;
    const c = makeCtx({ BACKLOT_SWEEP_MS: '300' });
    ctxs.push(c);
    const wt = c.worktree({ 'runly.yml': manifest('mysql'), 'echo.mjs': ECHO });
    const up = await c.cli(['up', '--json'], wt);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    const before = c.journal().allEnvs()[0]!;
    const searchNs = before.datastoreNs.search!;
    writeFileSync(join(es, `${searchNs}-vorgang`), 'indexed from the old store');
    // The service goes idle; then the manifest moves the source store.
    const idle = async () => {
      for (let i = 0; i < 100; i++) {
        if (Object.keys(c.journal().allEnvs()[0]?.servicePids ?? {}).length === 0) return true;
        await new Promise((r) => setTimeout(r, 200));
      }
      return false;
    };
    expect(await idle()).toBe(true);
    writeFileSync(join(wt, 'runly.yml'), manifest('mongodb'));
    // A verb resumes the service the way a connection would wake it.
    const exec = await c.cli(['exec', '--', 'true'], wt);
    expect(exec.code, exec.stderr + exec.stdout).toBe(0);
    const after = c.journal().allEnvs()[0]!;
    expect(after.datastoreNs.Mongo).not.toBe(before.datastoreNs.Mongo);
    expect(existsSync(join(server, after.datastoreNs.Mongo!))).toBe(true);
    expect(existsSync(join(server, before.datastoreNs.Mongo!))).toBe(false);
    expect(readdirSync(es)).toEqual([]);
  }, 120_000);

  it("a build sees the preset the restore resolves, also when the held one left the catalog", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'runly-build-preset-')));
    dirs.push(root);
    const server = join(root, 'server');
    mkdirSync(server);
    const manifest = (presets: string) => `name: build-preset
services:
  web:
    run: node echo.mjs
    build: 'echo {{datastores.mongo.preset}} > built.txt'
    port: web
    env:
      PORT: "{{ports.web}}"
      PRESET: "{{datastores.mongo.preset}}"
    ready: { http: /, timeout: 20 }
datastores:
  mongo:
    driver: mongodb
    url: "mongodb://127.0.0.1:47017/{{ns}}"
    presets: [${presets}]
    create: 'mkdir -p "${server}/{{ns}}" && echo {{preset}} > "${server}/{{ns}}/preset"'
    drop: 'rm -rf "${server}/{{ns}}"'
`;
    const c = makeCtx({ BACKLOT_SWEEP_MS: '600000' });
    ctxs.push(c);
    const wt = c.worktree({ 'runly.yml': manifest('hlt, demo'), 'echo.mjs': ECHO });
    const built = () => readFileSync(join(wt, 'built.txt'), 'utf8').trim();
    const held = () => readFileSync(join(server, c.journal().allEnvs()[0]!.datastoreNs.mongo!, 'preset'), 'utf8').trim();
    const demo = await c.cli(['up', '--preset', 'mongo=demo', '--json'], wt);
    expect(demo.code, demo.stderr + demo.stdout).toBe(0);
    expect([built(), held()]).toEqual(['demo', 'demo']);
    // `demo` leaves the catalog: the store is KEPT with what it holds…
    writeFileSync(join(wt, 'runly.yml'), manifest('hlt'));
    const kept = await c.cli(['up', '--json'], wt);
    expect(kept.code, kept.stderr + kept.stdout).toBe(0);
    expect([built(), held()]).toEqual(['demo', 'demo']);
    // …and a reset restores the default; the build saw that one too.
    const reset = await c.cli(['reset-data', '--json'], wt);
    expect(reset.code, reset.stderr + reset.stdout).toBe(0);
    expect([built(), held()]).toEqual(['hlt', 'hlt']);
    expect(((await (await fetch(reset.json.urls.web)).json()) as { preset: string }).preset).toBe('hlt');
  }, 120_000);

  it('refuses an elasticsearch datastore that is not ephemeral, and a derived_from that names nothing', async () => {
    const c = makeCtx();
    ctxs.push(c);
    const svc = 'services:\n  web:\n    run: "true"\n';
    const bad = c.worktree({ 'runly.yml': `name: es-bad\n${svc}datastores:\n  search:\n    driver: elasticsearch\n    url: http://127.0.0.1:49200\n` });
    const r1 = await c.cli(['up', '--json'], bad);
    expect(r1.code).toBe(1);
    expect(r1.json.error.message).toMatch(/must be 'ephemeral: true'/);
    const dangling = c.worktree({ 'runly.yml': `name: es-dangling\n${svc}datastores:\n  search:\n    driver: elasticsearch\n    ephemeral: true\n    derived_from: mongo\n    url: http://127.0.0.1:49200\n` });
    const r2 = await c.cli(['up', '--json'], dangling);
    expect(r2.code).toBe(1);
    expect(r2.json.error.message).toMatch(/derived_from 'mongo'.*does not declare/);
  }, 60_000);
});
