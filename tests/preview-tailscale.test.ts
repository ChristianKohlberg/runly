/**
 * The `tailscale` preview publisher (decision 0031).
 *
 * What it adds over the Cloudflare publishers is a private address: the
 * machine's own tailnet name, served by a FOREGROUND `tailscale serve` whose
 * mapping lives exactly as long as the process. So these tests assert the URL,
 * the port choice (pinned, derived, and walking past a busy port), the
 * refusals that must happen before anything is served, and that stopping the
 * preview ends the process — which is what ends the mapping.
 *
 * tailscale is faked. A real one would change the serve config of whatever
 * machine runs the suite, which is not a thing a test suite may do.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { scanTagged } from '../src/core/procscan.js';
import { deriveTailnetPort, tailnetPortsInUse } from '../src/drivers/preview.js';
import { disposeStateSync } from './support/leaks.js';
import { makeFakeTailscale } from './support/fake-tailscale.js';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanups) c();
});

function ctx(stackExtra: string, extraEnv: Record<string, string> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'runly-ts-'));
  const wt = mkdtempSync(join(tmpdir(), 'runly-ts-wt-'));
  const tsDir = join(stateDir, 'fake-ts');
  mkdirSync(tsDir, { recursive: true });
  writeFileSync(
    join(wt, 'srv.mjs'),
    `import{createServer}from'node:http';console.log('ready');createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');\n`,
  );
  writeFileSync(
    join(wt, 'runly.yml'),
    `name: tstest\nservices:\n  web: { run: node srv.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { log: ready, timeout: 20 } }\n${stackExtra}`,
  );
  execFileSync('git', ['init', '-q'], { cwd: wt });

  const env = {
    ...process.env,
    BACKLOT_STATE_DIR: stateDir,
    BACKLOT_SWEEP_MS: '300',
    BACKLOT_TAILSCALE: makeFakeTailscale(tsDir),
    FAKE_TS_DIR: tsDir,
    FAKE_TS_OPERATOR: userInfo().username,
    FAKE_PREVIEW_PIDFILE: join(stateDir, 'serve.pid'),
    ...extraEnv,
  };
  const cli = (args: string[], cwd = wt) =>
    new Promise<{ code: number; json?: Record<string, unknown>; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        let json: Record<string, unknown> | undefined;
        try {
          json = JSON.parse(String(stdout));
        } catch {
          /* non-json */
        }
        resolve({ code: err && typeof err === 'object' && 'code' in err ? Number(err.code) : 0, json, stdout: String(stdout), stderr: String(stderr) });
      });
    });

  const cleanup = () => {
    try {
      process.kill(Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8')), 'SIGKILL');
    } catch {
      /* gone */
    }
    for (const p of scanTagged(stateDir)) {
      try {
        process.kill(-p.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    try {
      process.kill(Number(readFileSync(join(stateDir, 'serve.pid'), 'utf8')), 'SIGKILL');
    } catch {
      /* never started */
    }
    disposeStateSync(stateDir);
    rmSync(wt, { recursive: true, force: true });
  };
  cleanups.push(cleanup);
  return { wt, cli, stateDir, tsDir, cleanup };
}

const TS = 'preview:\n  publisher: tailscale\n';

describe('the tailscale preview publisher', () => {
  it('publishes on the tailnet name at the pinned port, in the foreground', async () => {
    const { cli, tsDir } = ctx(`${TS}  https_port: 20601\n`);
    expect((await cli(['up', '--json'])).code).toBe(0);

    const prev = await cli(['preview', 'web', '--json']);
    expect(prev.code).toBe(0);
    expect(prev.json?.url).toBe('https://box.tail1234.ts.net:20601');

    const c = await cli(['ctx', '--json']);
    expect(c.json?.previewUrls).toEqual({ web: 'https://box.tail1234.ts.net:20601' });

    // Foreground — never --bg, whose config would outlive every reap path —
    // and aimed at the service's loopback port.
    const calls = readFileSync(join(tsDir, 'calls.txt'), 'utf8');
    expect(calls).toMatch(/^serve --https=20601 http:\/\/localhost:\d+$/m);
    expect(calls).not.toMatch(/--bg/);
  });

  it('derives a stable port when none is pinned', async () => {
    const { cli } = ctx(TS);
    await cli(['up', '--json']);
    const first = await cli(['preview', 'web', '--json']);
    expect(first.code).toBe(0);
    const url = String(first.json?.url);
    expect(url).toMatch(/^https:\/\/box\.tail1234\.ts\.net:32\d{3}$/);

    // A re-publish on the same environment hands out the same address.
    expect((await cli(['preview', 'stop', '--json'])).code).toBe(0);
    const again = await cli(['preview', 'web', '--json']);
    expect(again.json?.url).toBe(url);
  });

  it('--https-port pins the port for this publish, over the manifest', async () => {
    const { cli, tsDir } = ctx(`${TS}  https_port: 20601\n`);
    await cli(['up', '--json']);
    const prev = await cli(['preview', 'web', '--https-port', '20777', '--json']);
    expect(prev.code).toBe(0);
    expect(prev.json?.url).toBe('https://box.tail1234.ts.net:20777');
    expect(readFileSync(join(tsDir, 'calls.txt'), 'utf8')).toMatch(/^serve --https=20777 /m);
  });

  it('rejects a --https-port that is not a port (usage)', async () => {
    const { cli } = ctx(TS);
    await cli(['up', '--json']);
    const prev = await cli(['preview', 'web', '--https-port', 'abc', '--json']);
    expect(prev.code).toBe(64);
  });

  it('refuses a pinned port another publication holds, and serves nothing (work-error)', async () => {
    const { cli, tsDir } = ctx(`${TS}  https_port: 20601\n`, { FAKE_TS_BUSY: '20601' });
    await cli(['up', '--json']);

    const prev = await cli(['preview', 'web', '--json']);
    expect(prev.code).toBe(1);
    expect(String(prev.stderr + prev.stdout)).toMatch(/20601.*already served/);
    expect(readFileSync(join(tsDir, 'calls.txt'), 'utf8')).not.toMatch(/^serve --https/m);
  });

  it('refuses when the caller is not the tailscale operator, naming the command that fixes it', async () => {
    const { cli, tsDir } = ctx(TS, { FAKE_TS_OPERATOR: 'someone-else' });
    await cli(['up', '--json']);

    const prev = await cli(['preview', 'web', '--json']);
    expect(prev.code).toBe(2);
    expect(String(prev.stderr + prev.stdout)).toMatch(/tailscale set --operator=/);
    expect(readFileSync(join(tsDir, 'calls.txt'), 'utf8')).not.toMatch(/^serve --https/m);
  });

  it('refuses when tailscale is not connected', async () => {
    const { cli } = ctx(TS, { FAKE_TS_STATE: 'NeedsLogin' });
    await cli(['up', '--json']);

    const prev = await cli(['preview', 'web', '--json']);
    expect(prev.code).toBe(2);
    expect(String(prev.stderr + prev.stdout)).toMatch(/tailscale up/);
  });

  it('refuses a tailnet without HTTPS certificates', async () => {
    const { cli } = ctx(TS, { FAKE_TS_NOCERT: '1' });
    await cli(['up', '--json']);

    const prev = await cli(['preview', 'web', '--json']);
    expect(prev.code).toBe(2);
    expect(String(prev.stderr + prev.stdout)).toMatch(/HTTPS Certificates/);
  });

  it('turns tailscale access-denied into the operator hint', async () => {
    const { cli } = ctx(TS, { FAKE_TS_DENY: '1' });
    await cli(['up', '--json']);

    const prev = await cli(['preview', 'web', '--json']);
    expect(prev.code).toBe(2);
    expect(String(prev.stderr + prev.stdout)).toMatch(/tailscale set --operator=/);
  });

  it('stop ends the serve process, and with it the tailnet mapping', async () => {
    const { cli, stateDir, tsDir } = ctx(`${TS}  https_port: 20601\n`);
    await cli(['up', '--json']);
    await cli(['preview', 'web', '--json']);
    const pid = Number(readFileSync(join(stateDir, 'serve.pid'), 'utf8'));
    expect(existsSync(join(tsDir, 'serving', '20601'))).toBe(true);

    expect((await cli(['preview', 'stop', '--json'])).code).toBe(0);

    expect(await goneWithin(pid, 5000)).toBe(true);
    const c = await cli(['ctx', '--json']);
    expect(c.json?.previewUrls ?? {}).toEqual({});
  });
});

describe('the origin a publisher is aimed at', () => {
  it('is the service URL ctx advertises (localhost), so an IPv6-only dev server is reachable', async () => {
    // ng serve / vite bound to `localhost` listen on [::1] only under Node 17+;
    // a tunnel aimed at a literal 127.0.0.1 answered 502 for a healthy service.
    const { cli, wt, tsDir } = ctx(`${TS}  https_port: 20601\n`);
    writeFileSync(
      join(wt, 'srv.mjs'),
      `import{createServer}from'node:http';console.log('ready');createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT), '::1');\n`,
    );
    expect((await cli(['up', '--json'])).code).toBe(0);
    expect((await cli(['preview', 'web', '--json'])).code).toBe(0);
    const urls = ((await cli(['ctx', '--json'])).json?.urls ?? {}) as Record<string, string>;
    const served = /^serve --https=20601 (\S+)$/m.exec(readFileSync(join(tsDir, 'calls.txt'), 'utf8'))?.[1];
    expect(served).not.toBe(urls.web); // public preview has a deadline-enforcing origin
    expect((await fetch(served!)).status).toBe(200);
    expect(served).toMatch(/^http:\/\/localhost:\d+$/);
  });
});

describe('tailnet port choice', () => {
  it('is deterministic per environment and service', () => {
    const a = deriveTailnetPort('stack-e1', 'web', new Set());
    expect(deriveTailnetPort('stack-e1', 'web', new Set())).toBe(a);
    // The tunnel block (decision 0033): disjoint from the public 20000–29999
    // block and below every common ephemeral range.
    expect(a).toBeGreaterThanOrEqual(32000);
    expect(a).toBeLessThanOrEqual(32767);
  });

  it('walks past a port that is already served', () => {
    const a = deriveTailnetPort('stack-e1', 'web', new Set());
    const b = deriveTailnetPort('stack-e1', 'web', new Set([a]));
    expect(b).not.toBe(a);
    expect(b).toBe(a === 32767 ? 32000 : a + 1);
  });

  it('reads busy ports from both the persistent config and live foreground sessions', () => {
    const used = tailnetPortsInUse({
      TCP: { '20400': { HTTPS: true } },
      Foreground: { abc: { TCP: { '21007': { HTTPS: true } } } },
    });
    expect([...used].sort()).toEqual([20400, 21007]);
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
}

/**
 * A daemon restart re-publishes the lease's preview (decision 0045): same
 * publisher, same tailnet port, aimed at the public port the proxy holds
 * again — and the service wakes on the first request through it.
 */
describe('a daemon restart re-publishes the preview', () => {
  const daemonPid = (stateDir: string) => Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8'));
  const servePid = (stateDir: string) => Number(readFileSync(join(stateDir, 'serve.pid'), 'utf8'));
  const killDaemon = async (stateDir: string) => {
    const pid = daemonPid(stateDir);
    process.kill(pid, 'SIGKILL');
    expect(await goneWithin(pid, 5000)).toBe(true);
  };
  const waitCtx = async (cli: ReturnType<typeof ctx>['cli'], pred: (j: Record<string, unknown>) => boolean, ms = 20_000) => {
    const deadline = Date.now() + ms;
    let last: Record<string, unknown> | undefined;
    while (Date.now() < deadline) {
      last = (await cli(['ctx', '--json'])).json;
      if (last && pred(last)) return last;
      await new Promise((r) => setTimeout(r, 200));
    }
    return last;
  };

  it('after a SIGKILL: same URL, a new serve, and the request wakes the service', async () => {
    const { cli, stateDir, tsDir } = ctx(TS);
    expect((await cli(['up', '--json'])).code).toBe(0);
    // A derived port and a caller's override: both must come back as they were.
    const prev = await cli(['preview', 'web', '--https-port', '20777', '--json']);
    expect(prev.code, prev.stderr).toBe(0);
    const url = String(prev.json?.url);
    expect(url).toBe('https://box.tail1234.ts.net:20777');
    const before = servePid(stateDir);

    await killDaemon(stateDir);
    const after = await waitCtx(cli, (j) => (j.previewUrls as Record<string, string>)?.web === url && servePid(stateDir) !== before);
    expect(after?.previewUrls, JSON.stringify(after)).toEqual({ web: url });
    expect(after?.previewRestore).toBeNull();
    const now = servePid(stateDir);
    expect(now).not.toBe(before);
    expect(alive(now)).toBe(true);
    expect(await goneWithin(before, 5000)).toBe(true);
    const serves = readFileSync(join(tsDir, 'calls.txt'), 'utf8').split('\n').filter((l) => l.startsWith('serve --https='));
    expect(serves).toHaveLength(2);
    expect(serves[1]).toMatch(/^serve --https=20777 http:\/\/localhost:\d+$/); // origin can move; public address stays
    // The serve is aimed at the public port; the service was stopped by the
    // restart and wakes on the first request.
    const target = /http:\/\/localhost:(\d+)/.exec(serves[1]!)![1];
    const res = await fetch(`http://localhost:${target}/`);
    expect(await res.text()).toBe('ok');
    const ev = readFileSync(join(stateDir, 'events.jsonl'), 'utf8');
    expect(ev).toMatch(/restored the preview of 'web' at https:\/\/box\.tail1234\.ts\.net:20777/);
  }, 60_000);

  it('after a graceful stop too, and not after preview stop', async () => {
    const { cli, stateDir } = ctx(`${TS}  https_port: 20611\n`);
    expect((await cli(['up', '--json'])).code).toBe(0);
    expect((await cli(['preview', 'web', '--json'])).code).toBe(0);
    expect((await cli(['daemon', 'stop', '--json'])).code).toBe(0);
    const back = await waitCtx(cli, (j) => Object.keys((j.previewUrls as object) ?? {}).length > 0);
    expect(back?.previewUrls).toEqual({ web: 'https://box.tail1234.ts.net:20611' });

    expect((await cli(['preview', 'stop', '--json'])).code).toBe(0);
    await killDaemon(stateDir);
    const gone = await waitCtx(cli, () => true);
    await new Promise((r) => setTimeout(r, 1500));
    const later = (await cli(['ctx', '--json'])).json;
    expect(gone?.previewUrls).toEqual({});
    expect(later?.previewUrls).toEqual({});
    expect(later?.previewRestore).toBeNull();
  }, 60_000);

  it('a restore that fails is an event and ctx says so; preview stop forgets it', async () => {
    const { cli, stateDir, tsDir } = ctx(`${TS}  https_port: 20621\n`);
    expect((await cli(['up', '--json'])).code).toBe(0);
    expect((await cli(['preview', 'web', '--json'])).code).toBe(0);
    writeFileSync(join(tsDir, 'deny'), '');
    await killDaemon(stateDir);
    const failed = await waitCtx(cli, (j) => (j.previewRestore as { state?: string } | null)?.state === 'failed');
    expect(failed?.previewRestore).toMatchObject({ service: 'web', url: 'https://box.tail1234.ts.net:20621', state: 'failed' });
    expect(String((failed?.previewRestore as { error?: string }).error)).toMatch(/operator/);
    expect(failed?.previewUrls).toEqual({});
    expect(readFileSync(join(stateDir, 'events.jsonl'), 'utf8')).toMatch(/could not restore the preview of 'web'/);
    const stop = await cli(['preview', 'stop', '--json']);
    expect(stop.json?.stopped).toBe(true);
    expect((await cli(['ctx', '--json'])).json?.previewRestore).toBeNull();
  }, 60_000);
});

/**
 * Previews are per service within a lease (decision 0052): each service is
 * served on its own tailnet port by its own foreground `tailscale serve`, and
 * two services of one lease can never be pinned to the same port.
 */
describe('multi-service previews on the tailnet', () => {
  const API = '  api: { run: node srv.mjs, port: api, env: { PORT: "{{ports.api}}" }, ready: { log: ready, timeout: 20 } }\n';
  const servingPid = (tsDir: string, url: string) => Number(readFileSync(join(tsDir, 'serving', new URL(url).port), 'utf8'));

  it('serves each service on its own derived port; re-publishing one keeps its address and leaves the other alone', async () => {
    const { cli, tsDir } = ctx(`${API}${TS}`);
    expect((await cli(['up', '--json'])).code).toBe(0);
    const web = await cli(['preview', 'web', '--json']);
    expect(web.code, web.stderr).toBe(0);
    const api = await cli(['preview', 'api', '--json']);
    expect(api.code, api.stderr).toBe(0);
    const webUrl = String(web.json?.url);
    const apiUrl = String(api.json?.url);
    expect(webUrl).toMatch(/^https:\/\/box\.tail1234\.ts\.net:32\d{3}$/);
    expect(apiUrl).toMatch(/^https:\/\/box\.tail1234\.ts\.net:32\d{3}$/);
    expect(apiUrl).not.toBe(webUrl);
    expect((await cli(['ctx', '--json'])).json?.previewUrls).toEqual({ web: webUrl, api: apiUrl });
    const webPid = servingPid(tsDir, webUrl);
    const apiPid = servingPid(tsDir, apiUrl);
    expect(webPid).not.toBe(apiPid);

    const again = await cli(['preview', 'web', '--json']);
    expect(again.code, again.stderr).toBe(0);
    expect(again.json?.url).toBe(webUrl);
    expect(await goneWithin(webPid, 5000)).toBe(true);
    expect(alive(apiPid)).toBe(true);
    expect(servingPid(tsDir, apiUrl)).toBe(apiPid);

    expect((await cli(['preview', 'stop', 'api', '--json'])).code).toBe(0);
    expect(await goneWithin(apiPid, 5000)).toBe(true);
    expect((await cli(['ctx', '--json'])).json?.previewUrls).toEqual({ web: webUrl });
  }, 60_000);

  it('two services cannot pin the same port: the second is a work-error and the first keeps serving', async () => {
    const { cli, tsDir } = ctx(`${API}${TS}  https_port: 20631\n`);
    expect((await cli(['up', '--json'])).code).toBe(0);
    const web = await cli(['preview', 'web', '--json']);
    expect(web.code, web.stderr).toBe(0);
    expect(web.json?.url).toBe('https://box.tail1234.ts.net:20631');
    const webPid = servingPid(tsDir, String(web.json?.url));

    // The manifest pins 20631 for every publish, and web holds it.
    const clash = await cli(['preview', 'api', '--json']);
    expect(clash.code, clash.stdout + clash.stderr).toBe(1);
    expect(clash.stderr + clash.stdout).toMatch(/tailnet port 20631 is already pinned by this lease's preview of 'web'/);
    expect(alive(webPid)).toBe(true);

    // --https-port gives api its own port.
    const api = await cli(['preview', 'api', '--https-port', '20632', '--json']);
    expect(api.code, api.stderr).toBe(0);
    expect(api.json?.url).toBe('https://box.tail1234.ts.net:20632');

    // Re-pinning web onto api's port is refused the same way, and web keeps serving.
    const steal = await cli(['preview', 'web', '--https-port', '20632', '--json']);
    expect(steal.code).toBe(1);
    expect(steal.stderr + steal.stdout).toMatch(/tailnet port 20632 is already pinned by this lease's preview of 'api'/);
    expect(alive(webPid)).toBe(true);
    expect((await cli(['ctx', '--json'])).json?.previewUrls).toEqual({
      web: 'https://box.tail1234.ts.net:20631',
      api: 'https://box.tail1234.ts.net:20632',
    });
  }, 60_000);

  it('a daemon restart re-publishes every service at its own address', async () => {
    const { cli, stateDir, tsDir } = ctx(`${API}${TS}`);
    expect((await cli(['up', '--json'])).code).toBe(0);
    const web = await cli(['preview', 'web', '--https-port', '20641', '--json']);
    const api = await cli(['preview', 'api', '--json']);
    expect(web.code + api.code).toBe(0);
    const before = [servingPid(tsDir, String(web.json?.url)), servingPid(tsDir, String(api.json?.url))];
    const daemon = Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8'));
    process.kill(daemon, 'SIGKILL');
    expect(await goneWithin(daemon, 5000)).toBe(true);
    const deadline = Date.now() + 20_000;
    let urls: Record<string, string> = {};
    while (Date.now() < deadline) {
      urls = ((await cli(['ctx', '--json'])).json?.previewUrls as Record<string, string>) ?? {};
      if (Object.keys(urls).length === 2) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(urls).toEqual({ web: web.json?.url, api: api.json?.url });
    for (const pid of before) expect(await goneWithin(pid, 5000)).toBe(true);
    expect(alive(servingPid(tsDir, String(web.json?.url)))).toBe(true);
    expect(alive(servingPid(tsDir, String(api.json?.url)))).toBe(true);
  }, 60_000);
});
