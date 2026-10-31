/**
 * Concurrent starts fail as one call. Services start as soon as their own
 * depends_on are ready, side by side; when one start fails the call, the
 * others that are still booting are stopped AT ONCE — a bind stops everything
 * (`stop-all`), a wake or a verb's resume only what it started
 * (`stop-these`) — instead of being waited for until they are ready or hit
 * their own `ready.timeout`. A `{{…}}` typo is refused when the manifest is
 * loaded, before anything starts.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCtx, waitFor, type Ctx } from './support/context.js';
import { disposeStateSync } from './support/leaks.js';

const ctxs: Ctx[] = [];
const dirs: string[] = [];
afterAll(() => {
  for (const c of ctxs) c.dispose();
  for (const d of dirs) disposeStateSync(d);
});

// A service that records its pid, logs READY once its gate file exists, and
// logs BOOM shortly after it starts when its fail file exists.
const BOOT = `import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const [name, dir] = [process.argv[2], process.env.DIR];
writeFileSync(dir + '/' + name + '.pid', String(process.pid));
appendFileSync(dir + '/started.log', name + '\\n');
if (existsSync(dir + '/' + name + '.fail')) setTimeout(() => console.log('BOOM'), 300);
const t = setInterval(() => { if (existsSync(dir + '/' + name + '.gate')) { console.log('READY'); clearInterval(t); } }, 100);
setInterval(() => {}, 1 << 30);
`;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function fixture(c: Ctx, aTimeout: number) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'runly-start-failure-')));
  dirs.push(dir);
  const svc = (name: string, timeout: number) => `  ${name}:
    run: node boot.mjs ${name}
    idle: 2s
    env: { DIR: "${dir}" }
    fatal_logs: BOOM
    ready: { log: READY, timeout: ${timeout} }
`;
  const manifest = `name: start-failure\nservices:\n${svc('a', aTimeout)}${svc('b', 90)}`;
  const wt = c.worktree({ 'runly.yml': manifest, 'boot.mjs': BOOT });
  const pidOf = (name: string) => Number(readFileSync(join(dir, `${name}.pid`), 'utf8'));
  return { dir, wt, pidOf };
}

describe('a failed concurrent start stops its siblings at once', () => {
  it('bind (stop-all): a service that fails while another is still booting fails the up promptly, nothing left running', async () => {
    const c = makeCtx({ BACKLOT_SWEEP_MS: '600000' });
    ctxs.push(c);
    // `a` is never ready (an env-error after 2 s: the whole bind fails);
    // `b` would wait 90 s for its gate.
    const f = fixture(c, 2);
    const t0 = Date.now();
    const up = await c.cli(['up', '--json'], f.wt);
    const took = Date.now() - t0;
    expect(up.code, up.stderr + up.stdout).not.toBe(0);
    expect(up.json.error.message).toMatch(/'a' not ready after 2s/);
    expect(took, 'b was waited for instead of stopped').toBeLessThan(30_000);
    expect(existsSync(join(f.dir, 'b.pid'))).toBe(true);
    expect(await waitFor(() => !alive(f.pidOf('b')) && !alive(f.pidOf('a')), 10_000)).toBe(true);
    expect(Object.keys(c.journal().allEnvs()[0]?.servicePids ?? {})).toEqual([]);
  }, 90_000);

  it("wake (stop-these): a verb's resume whose start fails stops the sibling it started, promptly", async () => {
    const c = makeCtx({ BACKLOT_SWEEP_MS: '300' });
    ctxs.push(c);
    const f = fixture(c, 60);
    writeFileSync(join(f.dir, 'a.gate'), '');
    writeFileSync(join(f.dir, 'b.gate'), '');
    const up = await c.cli(['up', '--json'], f.wt);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    // Both go idle (2 s), keeping the lease.
    expect(await waitFor(() => Object.keys(c.journal().allEnvs()[0]?.servicePids ?? {}).length === 0, 20_000)).toBe(true);
    // Next start: `a` hits its fatal marker, `b` waits for a gate that never opens.
    writeFileSync(join(f.dir, 'a.fail'), '');
    rmSync(join(f.dir, 'a.gate'));
    rmSync(join(f.dir, 'b.gate'));
    const before = f.pidOf('b');
    const t0 = Date.now();
    const exec = await c.cli(['exec', '--', 'true'], f.wt);
    const took = Date.now() - t0;
    expect(exec.code, exec.stderr + exec.stdout).not.toBe(0);
    expect(exec.stderr + exec.stdout, `exit ${exec.code} after ${took} ms`).toMatch(/fatal log marker/);
    expect(took, 'b was waited for instead of stopped').toBeLessThan(30_000);
    const b = f.pidOf('b');
    expect(b).not.toBe(before);
    expect(await waitFor(() => !alive(b) && !alive(f.pidOf('a')), 10_000)).toBe(true);
    expect(Object.keys(c.journal().allEnvs()[0]?.servicePids ?? {})).toEqual([]);
  }, 120_000);

  it('a {{…}} typo is refused at load, before anything starts', async () => {
    const c = makeCtx();
    ctxs.push(c);
    const marker = realpathSync(mkdtempSync(join(tmpdir(), 'runly-template-typo-')));
    dirs.push(marker);
    const cases: Array<[string, RegExp]> = [
      [`services:\n  web:\n    run: node -e "require('fs').writeFileSync('${marker}/ran','')" {{ports.wbe}}\n    port: web\n`, /service 'web' run: in runly\.yml uses \{\{ports\.wbe\}\}, which is not a template variable; known here: \{\{ports\.web\}\}/],
      [`services:\n  web:\n    run: "true"\n    env: { DB: "{{datastores.main.url}}" }\n`, /service 'web' env DB .*\{\{datastores\.main\.url\}\}/],
      [`services:\n  web:\n    run: "true"\n    build: "echo {{env.name}}"\n`, /service 'web' build: .*\{\{env\.name\}\}.*known here: \{\{env\.id\}\}, \{\{env\.slug\}\}/],
      [`services:\n  web:\n    run: "true"\nauth:\n  token: "echo {{role}} {{rol}}"\n`, /auth\.token .*\{\{rol\}\}/],
    ];
    for (const [body, message] of cases) {
      const wt = c.worktree({ 'runly.yml': `name: typo\n${body}` });
      const up = await c.cli(['up', '--json'], wt);
      expect(up.code, up.stderr + up.stdout).toBe(1);
      expect(up.json.error.message).toMatch(message);
    }
    expect(existsSync(join(marker, 'ran'))).toBe(false);
    // Every documented variable, and {{role}} in auth.token, is accepted.
    const ok = c.worktree({
      'runly.yml': `name: typo-ok
services:
  web:
    run: "echo {{ports.web}} {{public_ports.web}} {{services.web.url}} {{ env.id }} {{env.slug}} && sleep 30"
    port: web
    ready: { log: ".", timeout: 20 }
    env: { DB: "{{datastores.main.url}} {{datastores.main.ns}} {{datastores.main.preset}}" }
datastores:
  main:
    driver: mongodb
    url: "mongodb://127.0.0.1:47017/{{ns}}"
    create: "true"
    drop: "true"
auth:
  token: "echo {{role}}"
`,
    });
    const good = await c.cli(['up', '--json'], ok);
    expect(good.code, good.stderr + good.stdout).toBe(0);
    await c.cli(['destroy', '--json'], ok);
  }, 90_000);
});
