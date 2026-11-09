/**
 * The fake `tailscale` CLI the tailscale-publisher tests share (decision 0031):
 * a real one would change the serve config of whatever machine runs the suite.
 */
import { writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A tailscale that answers `status --json`, `debug prefs` and
 * `serve status --json`, and plays a foreground `serve --https=<port> <url>`.
 *
 * Live sessions are files under FAKE_TS_DIR/serving/<port> holding the serving
 * pid, and `serve status` reports only those whose pid is alive — the same
 * "the mapping is the process" rule the real tailscaled applies to foreground
 * sessions. FAKE_TS_BUSY lists ports some other publication already holds.
 */
export function makeFakeTailscale(dir: string): string {
  const script = join(dir, 'fake-tailscale.mjs');
  writeFileSync(
    script,
    `import { writeFileSync, appendFileSync, existsSync, readdirSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const dir = process.env.FAKE_TS_DIR;
appendFileSync(join(dir, 'calls.txt'), args.join(' ') + '\\n');
const serving = join(dir, 'serving');
mkdirSync(serving, { recursive: true });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

if (args[0] === 'status' && args[1] === '--json') {
  process.stdout.write(JSON.stringify({
    BackendState: process.env.FAKE_TS_STATE || 'Running',
    Self: { DNSName: 'box.tail1234.ts.net.' },
    CertDomains: process.env.FAKE_TS_NOCERT ? null : ['box.tail1234.ts.net'],
  }));
  process.exit(0);
}
if (args[0] === 'debug' && args[1] === 'prefs') {
  process.stdout.write(JSON.stringify({ OperatorUser: process.env.FAKE_TS_OPERATOR ?? '' }));
  process.exit(0);
}
if (args[0] === 'serve' && args[1] === 'status') {
  const tcp = {};
  for (const p of (process.env.FAKE_TS_BUSY || '').split(',').filter(Boolean)) tcp[p] = { HTTPS: true };
  const fg = {};
  for (const f of readdirSync(serving)) {
    const pid = Number(readFileSync(join(serving, f), 'utf8'));
    if (alive(pid)) fg['s' + f] = { TCP: { [f]: { HTTPS: true } } };
  }
  process.stdout.write(JSON.stringify({ TCP: tcp, Foreground: fg }));
  process.exit(0);
}
if (args[0] === 'serve' && args[1].startsWith('--https=')) {
  const port = args[1].slice('--https='.length);
  if (process.env.FAKE_TS_DENY || existsSync(join(dir, 'deny'))) {
    console.error('sending serve config: Access denied: serve config denied');
    process.exit(1);
  }
  writeFileSync(join(serving, port), String(process.pid));
  writeFileSync(process.env.FAKE_PREVIEW_PIDFILE, String(process.pid));
  const drop = () => { rmSync(join(serving, port), { force: true }); process.exit(0); };
  process.on('SIGTERM', drop);
  process.on('SIGINT', drop);
  console.log('Available within your tailnet:\\n\\nhttps://box.tail1234.ts.net:' + port + '/\\n|-- proxy ' + args[2] + '\\n\\nPress Ctrl+C to exit.');
  setInterval(() => {}, 3600_000);
} else {
  console.error('fake tailscale: unhandled ' + args.join(' '));
  process.exit(64);
}
`,
  );
  const wrapper = join(dir, 'tailscale');
  writeFileSync(wrapper, `#!/bin/sh\nexec ${process.execPath} ${script} "$@"\n`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}
