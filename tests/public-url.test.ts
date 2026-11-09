/**
 * `{{services.<svc>.public_url}}` (decision 0053): where a browser outside this
 * machine reaches a service — the live preview, else the address the stack's
 * publisher would publish it at, else the local URL.
 *
 * What matters is that the value a service is STARTED with is the address a
 * later `runly preview` hands out (an IdP's redirect URI is registered from it),
 * that publishers which cannot name an address in advance fall back to the local
 * URL instead of failing the start, and that a stack which never names the
 * variable never pays for resolving it.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { scanTagged } from '../src/core/procscan.js';
import { publicUrlReferences } from '../src/core/manifest.js';
import type { Manifest } from '../src/core/manifest.js';
import { disposeStateSync } from './support/leaks.js';
import { makeFakeTailscale } from './support/fake-tailscale.js';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanups) c();
});

/** A stack whose `web` writes the public URL it was started with to `seen.txt`. */
function stack(opts: { preview?: string; env?: string; extraEnv?: Record<string, string> } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'runly-pub-'));
  const wt = mkdtempSync(join(tmpdir(), 'runly-pub-wt-'));
  const tsDir = join(stateDir, 'fake-ts');
  mkdirSync(tsDir, { recursive: true });
  writeFileSync(
    join(wt, 'srv.mjs'),
    `import{createServer}from'node:http';import{writeFileSync}from'node:fs';` +
      `writeFileSync('seen.txt', process.env.PUBLIC ?? '');console.log('ready');` +
      `createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');\n`,
  );
  const env = opts.env ?? 'PUBLIC: "{{services.web.public_url}}"';
  writeFileSync(
    join(wt, 'runly.yml'),
    `name: pubtest\nservices:\n  web: { run: node srv.mjs, port: web, env: { PORT: "{{ports.web}}", ${env} }, ready: { log: ready, timeout: 20 } }\n${opts.preview ?? ''}`,
  );
  execFileSync('git', ['init', '-q'], { cwd: wt });
  const processEnv = {
    ...process.env,
    BACKLOT_STATE_DIR: stateDir,
    BACKLOT_SWEEP_MS: '300',
    BACKLOT_TAILSCALE: makeFakeTailscale(tsDir),
    FAKE_TS_DIR: tsDir,
    FAKE_TS_OPERATOR: userInfo().username,
    FAKE_PREVIEW_PIDFILE: join(stateDir, 'serve.pid'),
    ...opts.extraEnv,
  };
  delete (processEnv as Record<string, string | undefined>).BACKLOT_PREVIEW_PUBLISHER;
  const cli = (args: string[]) =>
    new Promise<{ code: number; json?: Record<string, unknown>; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd: wt, env: processEnv, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
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
  const seen = () => readFileSync(join(wt, 'seen.txt'), 'utf8');
  const calls = () => (existsSync(join(tsDir, 'calls.txt')) ? readFileSync(join(tsDir, 'calls.txt'), 'utf8') : '');
  return { cli, seen, calls };
}

const TS = 'preview:\n  publisher: tailscale\n';

describe('{{services.<svc>.public_url}}', () => {
  it('tailscale: the service starts with the address the later preview hands out', async () => {
    const s = stack({ preview: TS });
    const up = await s.cli(['up', '--json']);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    const started = s.seen();
    expect(started).toMatch(/^https:\/\/box\.tail1234\.ts\.net:32\d{3}$/);

    const c = await s.cli(['ctx', '--json']);
    expect(c.json?.publicUrls).toEqual({ web: started });

    const prev = await s.cli(['preview', 'web', '--json']);
    expect(prev.code, prev.stderr + prev.stdout).toBe(0);
    expect(prev.json?.url).toBe(started);
    // Live, the preview's own URL is what ctx reports.
    expect((await s.cli(['ctx', '--json'])).json?.publicUrls).toEqual({ web: started });
  });

  it('tailscale: a pinned https_port is the port of the public URL', async () => {
    const s = stack({ preview: `${TS}  https_port: 20601\n` });
    expect((await s.cli(['up', '--json'])).code).toBe(0);
    expect(s.seen()).toBe('https://box.tail1234.ts.net:20601');
  });

  it('tailscale not connected: falls back to the local URL instead of failing the start', async () => {
    const s = stack({ preview: TS, extraEnv: { FAKE_TS_STATE: 'NeedsLogin' } });
    const up = await s.cli(['up', '--json']);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    expect(s.seen()).toMatch(/^http:\/\/localhost:\d+$/);
    expect(s.seen()).toBe((up.json?.urls as Record<string, string>).web);
  });

  it('cloudflare-named: the hostname is known before any tunnel exists', async () => {
    const s = stack({ preview: 'preview:\n  publisher: cloudflare-named\n  domain: example.dev\n  prefix: pr1\n' });
    expect((await s.cli(['up', '--json'])).code).toBe(0);
    expect(s.seen()).toBe('https://web-pr1.example.dev');
  });

  it('cloudflare-quick (the default) cannot name its address in advance: the local URL', async () => {
    const s = stack();
    const up = await s.cli(['up', '--json']);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    expect(s.seen()).toBe((up.json?.urls as Record<string, string>).web);
  });

  it('preview.forbidden: never published, so always the local URL — and the publisher is not asked', async () => {
    const s = stack({ preview: `${TS}  forbidden: true\n` });
    const up = await s.cli(['up', '--json']);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    expect(s.seen()).toMatch(/^http:\/\/localhost:\d+$/);
    expect(s.calls()).toBe('');
  });

  it('a stack that never names it never asks the publisher, and ctx lists nothing', async () => {
    const s = stack({ preview: TS, env: 'PUBLIC: "{{services.web.url}}"' });
    expect((await s.cli(['up', '--json'])).code).toBe(0);
    const c = await s.cli(['ctx', '--json']);
    expect(c.json?.publicUrls).toEqual({});
    expect(s.calls()).toBe('');
  });

  it('a portless service has no public_url (refused at load)', async () => {
    const s = stack({ env: 'PUBLIC: "{{services.worker.public_url}}"' });
    const up = await s.cli(['up', '--json']);
    expect(up.code).toBe(1);
    expect(String(up.stdout + up.stderr)).toMatch(/\{\{services\.worker\.public_url\}\}, which is not a template variable/);
  });
});

describe('publicUrlReferences', () => {
  it('lists every service some templated field names, once, sorted', () => {
    const manifest = {
      name: 'x',
      services: {
        api: { run: 'serve --origin {{services.web.public_url}}', port: 'api', env: { SELF: '{{ services.api.public_url }}' } },
        web: { run: 'serve', port: 'web', build: 'echo {{services.web.public_url}}' },
      },
      auth: { token: 'tok --origin {{services.api.public_url}} {{role}}' },
    } as unknown as Manifest;
    expect(publicUrlReferences(manifest)).toEqual(['api', 'web']);
    expect(publicUrlReferences({ name: 'y', services: { web: { run: 'x {{services.web.url}}' } } } as unknown as Manifest)).toEqual([]);
  });
});
