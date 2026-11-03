/**
 * Previews are per service within a lease (decision 0052): publishing one
 * service leaves the lease's other previews alone, `preview stop <service>`
 * stops one, `preview stop` all of them, and deadlines, reopening after `up`,
 * `down` and a daemon restart are judged per service. Cloudflare quick
 * tunnels are faked (one process per service, each with its own URL); the
 * tailscale half lives in preview-tailscale.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { alive, ctx, goneWithin, runPreviewCleanups } from './support/preview-fixture.js';
import { sleep } from './support/context.js';
import { scanTagged } from '../src/core/procscan.js';
import { formatDeadline } from '../src/core/units.js';

afterEach(runPreviewCleanups);

const PER_PID = { FAKE_PREVIEW_URL: 'https://fake-{pid}.trycloudflare.com' };
type Cli = ReturnType<typeof ctx>['cli'];
type View = { url: string | null; state: string; expiresAt: number | null; error?: string };

/** The tunnel pid of each service's preview, as `status --json` reports the lease's previews. */
async function tunnelPids(cli: Cli): Promise<Record<string, number>> {
  const st = await cli(['status', '--json']);
  const env = (st.json?.envs as Array<{ lease: { previews: Record<string, { pid?: number }> } | null }>)[0];
  const out: Record<string, number> = {};
  for (const [svc, p] of Object.entries(env?.lease?.previews ?? {})) if (p.pid) out[svc] = p.pid;
  return out;
}

async function waitCtx(cli: Cli, pred: (j: Record<string, unknown>) => boolean, ms = 20_000): Promise<Record<string, unknown> | undefined> {
  const deadline = Date.now() + ms;
  let last: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    last = (await cli(['ctx', '--json'])).json;
    if (last && pred(last)) return last;
    await sleep(200);
  }
  return last;
}

describe('multi-service previews (cloudflare quick)', () => {
  it('publishes each service on its own tunnel; re-publishing one leaves the other untouched', async () => {
    const { cli } = ctx(PER_PID);
    expect((await cli(['up', '--json'])).code).toBe(0);
    const web = await cli(['preview', 'web', '--json']);
    expect(web.code, web.stderr).toBe(0);
    const api = await cli(['preview', 'api', '--json']);
    expect(api.code, api.stderr).toBe(0);
    expect(web.json?.url).not.toBe(api.json?.url);

    const c = await cli(['ctx', '--json']);
    expect(c.json?.previewUrls).toEqual({ web: web.json?.url, api: api.json?.url });
    const previews = c.json?.previews as Record<string, View>;
    expect(previews.web).toMatchObject({ url: web.json?.url, state: 'live', expiresAt: web.json?.expiresAt });
    expect(previews.api).toMatchObject({ url: api.json?.url, state: 'live', expiresAt: api.json?.expiresAt });
    // The scalar summary is the earliest open deadline.
    expect(c.json?.previewExpiresAt).toBe(Math.min(Number(web.json?.expiresAt), Number(api.json?.expiresAt)));
    expect(c.json?.previewRestore).toBeNull();

    const pids = await tunnelPids(cli);
    expect(Object.keys(pids).sort()).toEqual(['api', 'web']);
    expect(pids.web).not.toBe(pids.api);
    expect(alive(pids.web!) && alive(pids.api!)).toBe(true);

    // Re-publishing web renews web only: a new tunnel for web, api's keeps running.
    const again = await cli(['preview', 'web', '--json']);
    expect(again.code, again.stderr).toBe(0);
    expect(await goneWithin(pids.web!, 5000)).toBe(true);
    expect(alive(pids.api!)).toBe(true);
    const after = await tunnelPids(cli);
    expect(after.api).toBe(pids.api);
    expect(after.web).not.toBe(pids.web);
    expect((await cli(['ctx', '--json'])).json?.previewUrls).toEqual({ web: again.json?.url, api: api.json?.url });
  }, 60_000);

  it('ps and status show every preview', async () => {
    const { cli } = ctx(PER_PID);
    expect((await cli(['up', '--json'])).code).toBe(0);
    const web = await cli(['preview', 'web', '--json']);
    const api = await cli(['preview', 'api', '--json']);

    const ps = await cli(['ps', '--json']);
    const rows = ps.json?.services as Array<{ service: string; preview: View | null }>;
    expect(rows.find((r) => r.service === 'web')?.preview).toMatchObject({ url: web.json?.url, state: 'live' });
    expect(rows.find((r) => r.service === 'api')?.preview).toMatchObject({ url: api.json?.url, state: 'live' });
    const psPlain = await cli(['ps']);
    expect(psPlain.stdout).toContain(`preview web: ${web.json?.url}`);
    expect(psPlain.stdout).toContain(`preview api: ${api.json?.url}`);

    const st = await cli(['status', '--json']);
    const env = (st.json?.envs as Array<{ previews: Record<string, View> }>)[0]!;
    expect(Object.keys(env.previews).sort()).toEqual(['api', 'web']);
    const stPlain = await cli(['status']);
    expect(stPlain.stdout).toContain(`preview web: ${web.json?.url}`);
    expect(stPlain.stdout).toContain(`preview api: ${api.json?.url}`);

    const summary = await cli(['ctx']);
    expect(summary.stdout).toContain(`(preview ${web.json?.url})`);
    expect(summary.stdout).toContain(`(preview ${api.json?.url})`);
  }, 60_000);

  it('ps and status print a deadline on another day with its date, today\'s as a time', async () => {
    const { cli } = ctx(PER_PID);
    expect((await cli(['up', '--json'])).code).toBe(0);
    // Three days out: a bare time of day would read as "later today".
    const web = await cli(['preview', 'web', '--ttl', String(3 * 24 * 60), '--json']);
    expect(web.code, web.stderr).toBe(0);
    const api = await cli(['preview', 'api', '--json']);
    expect(api.code, api.stderr).toBe(0);
    const views = ((await cli(['status', '--json'])).json?.envs as Array<{ previews: Record<string, View> }>)[0]!.previews;
    const webAt = views.web!.expiresAt!;
    const apiAt = views.api!.expiresAt!;
    const webWords = formatDeadline(webAt);
    expect(webWords).not.toBe(new Date(webAt).toLocaleTimeString());
    expect(webWords.endsWith(new Date(webAt).toLocaleTimeString())).toBe(true);

    for (const verb of ['ps', 'status']) {
      const plain = await cli([verb]);
      expect(plain.code, plain.stderr).toBe(0);
      expect(plain.stdout).toContain(`preview web: ${web.json?.url} (until ${webWords})`);
      expect(plain.stdout).toContain(`preview api: ${api.json?.url} (until ${formatDeadline(apiAt)})`);
    }
    // JSON keeps the epoch milliseconds.
    expect(typeof webAt).toBe('number');
  }, 60_000);

  it('preview stop <service> stops that one; preview stop stops all of them', async () => {
    const { cli } = ctx(PER_PID);
    expect((await cli(['up', '--json'])).code).toBe(0);
    expect((await cli(['preview', 'web', '--json'])).code).toBe(0);
    const api = await cli(['preview', 'api', '--json']);
    const pids = await tunnelPids(cli);

    const one = await cli(['preview', 'stop', 'web', '--json']);
    expect(one.code, one.stderr).toBe(0);
    expect(one.json).toMatchObject({ stopped: true, service: 'web', services: ['web'] });
    expect(await goneWithin(pids.web!, 5000)).toBe(true);
    expect(alive(pids.api!)).toBe(true);
    const c = await cli(['ctx', '--json']);
    expect(c.json?.previewUrls).toEqual({ api: api.json?.url });
    expect(Object.keys(c.json?.previews as object)).toEqual(['api']);

    // Stopping a service with no preview is not an error; a name that is no service is.
    expect((await cli(['preview', 'stop', 'web', '--json'])).json).toMatchObject({ stopped: false, services: [] });
    const typo = await cli(['preview', 'stop', 'nope', '--json']);
    expect(typo.code).toBe(1);
    expect(typo.stderr + typo.stdout).toMatch(/no service 'nope'/);

    expect((await cli(['preview', 'web', '--json'])).code).toBe(0);
    const both = await tunnelPids(cli);
    const all = await cli(['preview', 'stop', '--json']);
    expect(all.code, all.stderr).toBe(0);
    expect(all.json?.stopped).toBe(true);
    expect((all.json?.services as string[]).sort()).toEqual(['api', 'web']);
    expect(await goneWithin(both.web!, 5000)).toBe(true);
    expect(await goneWithin(both.api!, 5000)).toBe(true);
    const none = await cli(['ctx', '--json']);
    expect(none.json?.previewUrls).toEqual({});
    expect(none.json?.previews).toEqual({});
    expect(none.json?.previewExpiresAt).toBeNull();
  }, 60_000);

  it('down <service> ends that service\'s preview only', async () => {
    const { cli } = ctx(PER_PID);
    expect((await cli(['up', '--json'])).code).toBe(0);
    const web = await cli(['preview', 'web', '--json']);
    expect((await cli(['preview', 'api', '--json'])).code).toBe(0);
    const pids = await tunnelPids(cli);
    const down = await cli(['down', 'api', '--json']);
    expect(down.code, down.stderr).toBe(0);
    expect(String(down.json?.previewNotice)).toMatch(/service 'api' is not in this bind's running set/);
    expect(String(down.json?.previewNotice)).not.toMatch(/run 'runly preview web'/);
    expect(await goneWithin(pids.api!, 5000)).toBe(true);
    expect(alive(pids.web!)).toBe(true);
    expect((await cli(['ctx', '--json'])).json?.previewUrls).toEqual({ web: web.json?.url });
  }, 60_000);

  it('deadlines are per service: one expires, the other stays live; up reopens only what was not stopped', async () => {
    const { cli } = ctx(PER_PID);
    expect((await cli(['up', '--json'])).code).toBe(0);
    const web = await cli(['preview', 'web', '--ttl', '0.02', '--json']);
    expect(web.code, web.stderr).toBe(0);
    const api = await cli(['preview', 'api', '--json']);
    const pids = await tunnelPids(cli);

    const expired = await waitCtx(cli, (j) => (j.previews as Record<string, View>)?.web?.state === 'expired');
    expect((expired?.previews as Record<string, View>).web).toMatchObject({ state: 'expired', expiresAt: web.json?.expiresAt });
    expect((expired?.previews as Record<string, View>).api).toMatchObject({ state: 'live' });
    expect(expired?.previewUrls).toEqual({ api: api.json?.url });
    expect(expired?.previewRestore).toMatchObject({ service: 'web', state: 'expired' });
    // The summary is the earliest deadline still open: api's.
    expect(expired?.previewExpiresAt).toBe(api.json?.expiresAt);
    expect(await goneWithin(pids.web!, 5000)).toBe(true);
    expect(alive(pids.api!)).toBe(true);

    // A successful up reopens web for its TTL and leaves api's tunnel alone.
    const up = await cli(['up', '--json']);
    expect(up.code, up.stderr).toBe(0);
    expect(Object.keys(up.json?.previewUrls as object).sort()).toEqual(['api', 'web']);
    expect((await tunnelPids(cli)).api).toBe(pids.api);

    // preview stop web disables reopening web; api is not touched.
    await waitCtx(cli, (j) => (j.previews as Record<string, View>)?.web?.state === 'expired');
    expect((await cli(['preview', 'stop', 'web', '--json'])).json?.stopped).toBe(true);
    const again = await cli(['up', '--json']);
    expect(again.code, again.stderr).toBe(0);
    expect(again.json?.previewUrls).toEqual({ api: api.json?.url });
    expect(Object.keys(again.json?.previews as object)).toEqual(['api']);
  }, 60_000);

  it('a daemon restart re-publishes every service\'s preview', async () => {
    const { cli, stateDir } = ctx(PER_PID);
    expect((await cli(['up', '--json'])).code).toBe(0);
    expect((await cli(['preview', 'web', '--json'])).code).toBe(0);
    expect((await cli(['preview', 'api', '--json'])).code).toBe(0);
    const before = await tunnelPids(cli);
    const daemon = Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8'));
    process.kill(daemon, 'SIGKILL');
    expect(await goneWithin(daemon, 5000)).toBe(true);

    const back = await waitCtx(cli, (j) => Object.keys((j.previewUrls as object) ?? {}).length === 2);
    expect(Object.keys(back?.previewUrls as object).sort()).toEqual(['api', 'web']);
    const after = await tunnelPids(cli);
    expect(after.web).not.toBe(before.web);
    expect(after.api).not.toBe(before.api);
    expect(await goneWithin(before.web!, 5000)).toBe(true);
    expect(await goneWithin(before.api!, 5000)).toBe(true);
    // The quick publisher cannot keep an address: each URL is the new tunnel's.
    expect((back?.previewUrls as Record<string, string>).web).toBe(`https://fake-${after.web}.trycloudflare.com`);
    expect((back?.previewUrls as Record<string, string>).api).toBe(`https://fake-${after.api}.trycloudflare.com`);
  }, 60_000);

  it('release reaps every tunnel of the lease', async () => {
    const { cli } = ctx(PER_PID);
    expect((await cli(['up', '--json'])).code).toBe(0);
    expect((await cli(['preview', 'web', '--json'])).code).toBe(0);
    expect((await cli(['preview', 'api', '--json'])).code).toBe(0);
    const pids = await tunnelPids(cli);
    expect((await cli(['release', '--json'])).code).toBe(0);
    expect(await goneWithin(pids.web!, 5000)).toBe(true);
    expect(await goneWithin(pids.api!, 5000)).toBe(true);
  }, 60_000);


  it.skipIf(process.platform !== 'linux')('pool gc leaves every leased tunnel of a quiesced environment alone', async () => {
    const { cli, stateDir } = ctx(PER_PID);
    const up = await cli(['up', '--json']);
    expect(up.code).toBe(0);
    expect((await cli(['preview', 'web', '--json'])).code).toBe(0);
    expect((await cli(['preview', 'api', '--json'])).code).toBe(0);
    const pids = await tunnelPids(cli);
    // Each tunnel is tagged with its own service, in its own process group.
    const tagged = scanTagged(stateDir);
    expect(tagged.find((p) => p.pid === pids.web)?.service).toBe('preview:web');
    expect(tagged.find((p) => p.pid === pids.api)?.service).toBe('preview:api');
    // A warm (quiesced) environment may run nothing but its lease's tunnels.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(stateDir, 'journal.db'));
    try {
      db.prepare("UPDATE envs SET state = 'warm' WHERE id = ?").run(String(up.json?.envId));
    } finally { db.close(); }
    const gc = await cli(['pool', 'gc', '--json']);
    expect(gc.code, gc.stderr).toBe(0);
    await sleep(500);
    expect(alive(pids.web!)).toBe(true);
    expect(alive(pids.api!)).toBe(true);
  }, 60_000);
});

describe('upgrading a schema-5 journal (decision 0052)', () => {
  it('a preview recorded in the old lease columns is reaped and re-published by the new daemon', async () => {
    const { cli, stateDir } = ctx(PER_PID);
    expect((await cli(['up', '--json'])).code).toBe(0);
    const web = await cli(['preview', 'web', '--json']);
    expect(web.code, web.stderr).toBe(0);
    const before = await tunnelPids(cli);
    const daemon = Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8'));
    process.kill(daemon, 'SIGKILL');
    expect(await goneWithin(daemon, 5000)).toBe(true);
    // Rewrite the journal into the shape a schema-5 runly left: the one
    // preview (live tunnel and restore record) on the lease row itself.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(stateDir, 'journal.db'));
    try {
      for (const col of ['preview_service TEXT', 'preview_url TEXT', 'preview_pid INTEGER', 'preview_start INTEGER', 'preview_port INTEGER', 'preview_restore TEXT']) {
        db.exec(`ALTER TABLE leases ADD COLUMN ${col}`);
      }
      const row = db.prepare('SELECT * FROM lease_previews').get() as Record<string, unknown>;
      db.prepare('UPDATE leases SET preview_service=?, preview_url=?, preview_pid=?, preview_start=?, preview_port=?, preview_restore=? WHERE id=?')
        .run(String(row.service), String(row.url), Number(row.pid), Number(row.start), Number(row.port), String(row.restore), String(row.lease_id));
      db.exec('DROP TABLE lease_previews');
      db.exec('PRAGMA user_version = 5');
    } finally { db.close(); }

    // The next verb autospawns the new daemon: it migrates, reaps the old
    // tunnel by its recorded pid, and publishes web again.
    const back = await waitCtx(cli, (j) => typeof (j.previewUrls as Record<string, string> | undefined)?.web === 'string' && (j.previewUrls as Record<string, string>).web !== web.json?.url);
    expect(Object.keys(back?.previewUrls as object)).toEqual(['web']);
    expect(await goneWithin(before.web!, 5000)).toBe(true);
    const after = await tunnelPids(cli);
    expect(alive(after.web!)).toBe(true);
    expect((back?.previews as Record<string, View>).web).toMatchObject({ state: 'live', expiresAt: web.json?.expiresAt });
  }, 60_000);
});
