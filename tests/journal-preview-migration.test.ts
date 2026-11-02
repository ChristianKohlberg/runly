/**
 * Schema 5 -> 6 (decision 0052): a lease's single preview moves from its
 * `preview_*` columns into `lease_previews`, keyed by service — the live
 * tunnel and the restore record alike — and the per-service writers leave
 * the lease's other previews alone.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, JOURNAL_SCHEMA_VERSION } from '../src/core/journal.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A journal exactly as a schema-5 runly (0.21/0.22) wrote it, with two leases. */
function schema5Journal(): string {
  const dir = mkdtempSync(join(tmpdir(), 'runly-journal-6-'));
  dirs.push(dir);
  const path = join(dir, 'journal.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE envs (
      id TEXT PRIMARY KEY, stack TEXT NOT NULL, stack_root TEXT NOT NULL,
      state TEXT NOT NULL, root TEXT NOT NULL,
      ports TEXT NOT NULL DEFAULT '{}', datastore_ns TEXT NOT NULL DEFAULT '{}',
      fingerprints TEXT NOT NULL DEFAULT '{}', presets TEXT NOT NULL DEFAULT '{}',
      bind_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL,
      service_pids TEXT NOT NULL DEFAULT '{}',
      fail_streak INTEGER NOT NULL DEFAULT 0,
      active_services TEXT, activity TEXT, drop_recipes TEXT, templates TEXT
    );
    CREATE TABLE leases (
      id TEXT PRIMARY KEY, env_id TEXT NOT NULL, kind TEXT NOT NULL,
      holder TEXT NOT NULL, hygiene TEXT NOT NULL, expires_at INTEGER NOT NULL,
      holder_pid INTEGER, holder_start INTEGER,
      preview_service TEXT, preview_url TEXT, preview_pid INTEGER, preview_start INTEGER, preview_port INTEGER,
      preview_restore TEXT
    );
    PRAGMA user_version = 5;
  `);
  for (const [id, n] of [['s-e1', 1], ['s-e2', 2], ['s-e3', 3]] as const) {
    db.prepare(`INSERT INTO envs (id, stack, stack_root, state, root, created_at, last_used_at) VALUES (?, 's', ?, 'hot', ?, 0, 0)`).run(id, `/wt${n}`, `/envs/${id}`);
  }
  const restore = { expiresAt: 1_900_000_000_000, ttlMs: 1_800_000, service: 'web', url: 'https://a.trycloudflare.com', port: 20001, publisher: 'cloudflare-quick', settings: {} };
  // A live tunnel with its restore record.
  db.prepare(`INSERT INTO leases VALUES ('l-live', 's-e1', 'session', '/wt1', 'reuse', 9007199254740991, NULL, NULL, 'web', 'https://a.trycloudflare.com', 4242, 77, 20001, ?)`).run(JSON.stringify(restore));
  // An expired publication only (no tunnel): what a successful up reopens.
  db.prepare(`INSERT INTO leases VALUES ('l-restore', 's-e2', 'session', '/wt2', 'reuse', 9007199254740991, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`).run(JSON.stringify({ ...restore, service: 'api', url: 'https://b.trycloudflare.com', port: 20011, expiresAt: 1 }));
  // No preview at all.
  db.prepare(`INSERT INTO leases VALUES ('l-none', 's-e3', 'session', '/wt3', 'reuse', 9007199254740991, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`).run();
  db.close();
  return path;
}

describe('journal schema 6: previews per service', () => {
  it('migrates a schema-5 lease preview losslessly into lease_previews', () => {
    const path = schema5Journal();
    const j = new Journal(path);
    const live = j.leaseForEnv('s-e1')!;
    expect(live.previews).toEqual({
      web: {
        service: 'web', url: 'https://a.trycloudflare.com', pid: 4242, start: 77, port: 20001,
        restore: { expiresAt: 1_900_000_000_000, ttlMs: 1_800_000, service: 'web', url: 'https://a.trycloudflare.com', port: 20001, publisher: 'cloudflare-quick', settings: {} },
      },
    });
    const pending = j.leaseForEnv('s-e2')!;
    expect(Object.keys(pending.previews)).toEqual(['api']);
    expect(pending.previews.api).toMatchObject({ service: 'api', restore: { service: 'api', url: 'https://b.trycloudflare.com', port: 20011, expiresAt: 1 } });
    expect(pending.previews.api!.pid).toBeUndefined();
    expect(j.leaseForEnv('s-e3')!.previews).toEqual({});
    expect(j.allLeases().find((l) => l.id === 'l-live')!.previews.web!.pid).toBe(4242);

    const raw = new DatabaseSync(path, { readOnly: true });
    try {
      expect((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(JOURNAL_SCHEMA_VERSION);
      expect(JOURNAL_SCHEMA_VERSION).toBe(6);
      // The old columns are cleared, so nothing can read a stale copy of them.
      const old = raw.prepare('SELECT COUNT(*) AS n FROM leases WHERE preview_pid IS NOT NULL OR preview_restore IS NOT NULL').get() as { n: number };
      expect(old.n).toBe(0);
    } finally { raw.close(); }

    // Opening again migrates nothing twice.
    const again = new Journal(path);
    expect(again.leaseForEnv('s-e1')!.previews.web!.pid).toBe(4242);
    expect(again.allLeases().flatMap((l) => Object.keys(l.previews)).sort()).toEqual(['api', 'web']);
  });

  it('per-service writers touch only their own service', () => {
    const path = schema5Journal();
    const j = new Journal(path);
    const restore = { expiresAt: 2_000_000_000_000, ttlMs: 60_000, service: 'api', url: 'https://c.trycloudflare.com', port: 20002 };
    j.setLeasePreview('l-live', 'api', { url: restore.url, pid: 5151, start: 9, port: 20002 });
    j.setLeasePreviewRestore('l-live', 'api', restore);
    expect(Object.keys(j.leaseForEnv('s-e1')!.previews).sort()).toEqual(['api', 'web']);

    // CAS on the pid: a stale stop of web does nothing; the right one clears only web's tunnel.
    j.clearLeasePreview('l-live', 'web', 1);
    expect(j.leaseForEnv('s-e1')!.previews.web!.pid).toBe(4242);
    j.clearLeasePreview('l-live', 'web', 4242);
    const after = j.leaseForEnv('s-e1')!;
    expect(after.previews.web!.pid).toBeUndefined();
    expect(after.previews.web!.restore).toBeDefined(); // the publication intent survives the reap
    expect(after.previews.api!.pid).toBe(5151);

    // Forgetting web's intent drops its (now empty) row; api is untouched.
    j.setLeasePreviewRestore('l-live', 'web', null);
    expect(Object.keys(j.leaseForEnv('s-e1')!.previews)).toEqual(['api']);

    // Nothing is recorded for a lease that no longer exists, and deleting a lease takes its previews.
    j.setLeasePreview('l-gone', 'web', { url: 'x', pid: 1, port: 1 });
    j.setLeasePreviewRestore('l-gone', 'web', restore);
    j.deleteLease('l-live');
    const raw = new DatabaseSync(path, { readOnly: true });
    try {
      expect((raw.prepare("SELECT COUNT(*) AS n FROM lease_previews WHERE lease_id IN ('l-live', 'l-gone')").get() as { n: number }).n).toBe(0);
    } finally { raw.close(); }

    // deleteEnv takes the previews of the env's lease too.
    j.deleteEnv('s-e2');
    expect(j.allLeases().map((l) => l.id)).toEqual(['l-none']);
    const raw2 = new DatabaseSync(path, { readOnly: true });
    try {
      expect((raw2.prepare('SELECT COUNT(*) AS n FROM lease_previews').get() as { n: number }).n).toBe(0);
    } finally { raw2.close(); }
  });
});
