/**
 * A service starts as soon as its own depends_on are ready — never behind a
 * slow service it does not depend on. A consumer's index sync (no depends_on,
 * ready only after minutes of indexing) held back its portal (depends_on
 * [ere]) after every `reset-data`: the starts of one round ran one after
 * another, each awaiting readiness, so `web` waited for `sync` too. The sync
 * here is ready only once the test opens a gate; `web` must be up before that,
 * on a fresh `up` and on the restart after a restore.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCtx, type Ctx } from './support/context.js';
import { disposeStateSync } from './support/leaks.js';

const ctxs: Ctx[] = [];
const dirs: string[] = [];
afterAll(() => {
  for (const c of ctxs) c.dispose();
  for (const d of dirs) disposeStateSync(d);
});

// An HTTP service that notes its start in the log.
const HTTP = `import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
appendFileSync(process.env.LOG, process.argv[2] + '\\n');
createServer((q, s) => s.end(process.argv[2])).listen(Number(process.env.PORT), '127.0.0.1');
`;
// The sync: ready ("following") only once the gate file exists.
const SYNC = `import { appendFileSync, existsSync } from 'node:fs';
appendFileSync(process.env.LOG, 'sync\\n');
const t = setInterval(() => { if (existsSync(process.env.GATE)) { console.log('following'); clearInterval(t); } }, 100);
setInterval(() => {}, 1 << 30);
`;

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
}

describe('service start order', () => {
  it('starts a service once its own depends_on are ready, not after an unrelated slow one (up and reset-data)', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'runly-start-order-')));
    dirs.push(root);
    const log = join(root, 'started.log');
    const gate = join(root, 'gate');
    const mongo = join(root, 'mongo');
    const env = (extra = '') => `    env:\n      LOG: "${log}"\n      DB: "{{datastores.mongo.ns}}"\n${extra}`;
    const manifest = `name: start-order
services:
  ere:
    run: node http.mjs ere
    port: ere
${env('      PORT: "{{ports.ere}}"\n')}    ready: { http: /, timeout: 30 }
  web:
    run: node http.mjs web
    port: web
    depends_on: [ere]
${env('      PORT: "{{ports.web}}"\n')}    ready: { http: /, timeout: 30 }
  sync:
    run: node sync.mjs
    idle: never
${env(`      GATE: "${gate}"\n`)}    ready: { log: following, timeout: 60 }
datastores:
  mongo:
    driver: mongodb
    url: "mongodb://127.0.0.1:47017/{{ns}}"
    create: 'mkdir -p "${mongo}/{{ns}}"'
    drop: 'rm -rf "${mongo}/{{ns}}"'
  search:
    driver: elasticsearch
    ephemeral: true
    derived_from: mongo
    url: "http://127.0.0.1:49200"
    drop: "true"
`;
    const c = makeCtx({ BACKLOT_SWEEP_MS: '600000' });
    ctxs.push(c);
    const wt = c.worktree({ 'runly.yml': manifest, 'http.mjs': HTTP, 'sync.mjs': SYNC });
    const started = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);

    for (const args of [['up', '--json'], ['reset-data', 'mongo', '--json']]) {
      rmSync(gate, { force: true });
      writeFileSync(log, '');
      const run = c.cli(args, wt);
      // web depends only on ere: it starts while sync is still not ready.
      const webFirst = await until(() => started().includes('web'), 20_000);
      const before = started();
      writeFileSync(gate, '');
      const r = await run;
      expect(r.code, r.stderr + r.stdout).toBe(0);
      expect(webFirst, `${args[0]}: web did not start before the unrelated sync was ready (started: ${before.join(', ')})`).toBe(true);
      expect(before).toContain('sync');
      const web = await fetch(r.json.urls.web);
      expect(await web.text()).toBe('web');
    }
  }, 120_000);
});
