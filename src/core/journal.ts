/**
 * The per-machine journal: disk is truth, daemon memory is a cache
 * (decision 0009). node:sqlite — zero native deps.
 */
import { DatabaseSync } from 'node:sqlite';
import { journalPath } from './paths.js';
import { BrokerError } from './util.js';
import type { EnvState, Hygiene, LeaseKind, ServicePid } from './types.js';

/**
 * The journal schema this build understands, stamped into `PRAGMA user_version`.
 *
 * Bump it when a change makes an OLDER daemon misread this journal — not for
 * every additive column: a bump is unnecessary when an old daemon selecting
 * a known subset of columns still reads the journal correctly.
 *
 * Schemas 1-3 belong to runly before 0.16 and are refused: their migrations
 * were retired in 0.19 (upgrade through 0.18 first).
 *
 * Schema 4 (decision 0034): `active_services = '[]'` means "no services are
 * wanted" (an older daemon reads an empty list as the whole app and would boot
 * it), the `db_copies` table holds database copies an older daemon would never
 * reap, and data-only environments are gone (0.18 migrated them away).
 *
 * What this exists to stop is the DOWNGRADE, which has already cost once. The
 * sha256 env-id migration stranded pre-upgrade rows that then counted against
 * POOL_MAX_TOTAL and held their ports forever (BACKLOG.md), because nothing on
 * disk said which build wrote them. A running example of the same shape:
 * `data_only` defaults to 0, so a 0.7.0 daemon re-binding a 0.8.0 data-only
 * environment reads "not data-only" and boots the whole application into a
 * test lane's database. Disk is truth (decision 0009), so the truth has to say
 * what wrote it.
 */
// Schema 5: worktree-owned environments must not be opened by a daemon that
// destroys them on holder death, idle expiry or automatic capacity eviction.
// Schema 6 (decision 0052): previews live in `lease_previews`, one row per
// <lease, service>. A schema-5 daemon reads only the lease's `preview_*`
// columns, so it would see no tunnel at all — never reap one, never restore
// one — and an unnamed preview pid is a public URL that serves forever.
export const JOURNAL_SCHEMA_VERSION = 6;
/** SQLite-safe sentinel for an explicitly non-expiring lease. Exposed as null in ctx. */
/** The oldest stamp this build still opens (decision 0042); older journals are refused untouched. */
export const OLDEST_READABLE_JOURNAL_SCHEMA = 4;
export const NO_LEASE_EXPIRY = Number.MAX_SAFE_INTEGER;

/**
 * service_pids was once `{"web": 1234}` and is now
 * `{"web": {"pid":1234,"startTime":99}}`. Journals outlive releases, so read
 * both shapes; a bare number simply has no identity pin (see ServicePid).
 */
function parseJson<T>(raw: unknown): T | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function parseServicePids(raw: string): Record<string, ServicePid> {
  const out: Record<string, ServicePid> = {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object') return out;
  for (const [name, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'number') out[name] = { pid: v };
    else if (v && typeof v === 'object' && typeof (v as ServicePid).pid === 'number') {
      out[name] = { pid: (v as ServicePid).pid, startTime: (v as ServicePid).startTime,
        ...(typeof (v as ServicePid).pgid === 'number' ? { pgid: (v as ServicePid).pgid } : {}),
        ...(Array.isArray((v as ServicePid).pgids) ? { pgids: (v as ServicePid).pgids!.filter(g => Number.isSafeInteger(g) && g > 0) } : {}) };
    }
  }
  return out;
}

export interface EnvRow {
  id: string;
  stack: string;
  stackRoot: string;
  state: EnvState;
  root: string;
  ports: Record<string, number>;
  datastoreNs: Record<string, string>;
  fingerprints: Record<string, string>;
  presets: Record<string, string>;
  bindCount: number;
  createdAt: number;
  lastUsedAt: number;
  servicePids: Record<string, ServicePid>;
  /** Consecutive bind failures; retry requires up and never implicitly resets data. */
  failStreak: number;
  /**
   * The services this environment's lease WANTS up (decision 0034): `up`
   * adds to it, `down` takes away. Undefined means every service the
   * manifest declares (so a service added to the manifest later is included);
   * `[]` means none — the shape `down` with no names leaves. The running set
   * is the supervisor's; this is the intent a quiesce or a daemon restart
   * keeps, and the next `up` restores.
   */
  activeServices?: string[];
  /**
   * When each public port last carried a byte in either direction (decision 0035), by port
   * key. Persisted (throttled) so a daemon restart does not reset every idle
   * clock to "active"; the proxy's in-memory counters start from it.
   */
  activity?: Record<string, number>;
  /**
   * How to drop each datastore namespace this environment holds, recorded
   * when it is created (decision 0037): the templated drop command and where
   * to run it, or the file to delete. Teardown needs neither the manifest nor
   * the worktree — both may be gone by the time it runs.
   */
  dropRecipes?: Record<string, DropRecipe>;
  /** The template each datastore was last restored from (decision 0037: templates are kept by reference). */
  templates?: Record<string, string>;
}

/** Everything needed to drop one namespace without the manifest (decision 0037). */
export interface DropRecipe {
  cmd?: string;
  cwd?: string;
  /** The server-side namespace the drop removes (0.16.1+), referenced from before it is created. */
  ns?: string;
  /** A file (sqlite) to delete instead, with its -wal/-shm/-journal sidecars. */
  path?: string;
}

export interface LeaseRow {
  id: string;
  envId: string;
  kind: LeaseKind;
  holder: string;
  hygiene: Hygiene;
  expiresAt: number;
  /** Optional diagnostic process identity. Never controls environment lifetime. */
  holderPid?: number;
  holderStart?: number;
  /**
   * The lease's public previews, one per service (decision 0052), keyed by
   * service. Read from the `lease_previews` table; never written by
   * `saveLease` — only the dedicated preview writers below touch it, so a
   * stale lease snapshot cannot erase a tunnel someone else just published.
   */
  previews: Record<string, LeasePreview>;
}

/**
 * One service's preview on a lease (decision 0052): the live tunnel, when one
 * runs, and what a restart or a successful `up` publishes again.
 */
export interface LeasePreview {
  service: string;
  /** Active lease-scoped public preview tunnel, when one runs. */
  url?: string;
  pid?: number;
  start?: number;
  /** Local port the tunnel was published against, so a rebind can spot drift. */
  port?: number;
  /**
   * What `runly preview` published, kept until the preview is stopped on
   * purpose (0.20, decision 0045): a daemon restart reaps the tunnel and
   * publishes it again from this. Written only by `setLeasePreviewRestore`.
   */
  restore?: PreviewRestore;
}

/** A published preview, as a restart re-publishes it (decision 0045). */
export interface PreviewRestore {
  /** Absolute public-access deadline. Missing legacy deadlines are revoked on recovery. */
  expiresAt?: number;
  /** Duration reused when a successful up renews active public access. */
  ttlMs?: number;
  service: string;
  /** The URL it had; a publisher that pins its address gives the same one again. */
  url: string;
  /** The environment's public port it was aimed at. */
  port: number;
  /** The publisher, by name; absent for a preview published before 0.20 (the manifest's then). */
  publisher?: string;
  /** The settings that reproduce the address (the manifest's `preview` block plus what the publisher pinned). */
  settings?: Record<string, unknown>;
}

/**
 * A database copy made by `runly db new|with` (decision 0034): a fresh restore
 * from the same template an environment's datastore uses, with no lease, ports
 * or services. Everything needed to DROP it is on the row — the command, where
 * to run it, the files to remove — so it can be reaped after the worktree that
 * made it is gone.
 */
export interface DbCopyRow {
  name: string;
  stack: string;
  stackRoot: string;
  datastore: string;
  preset: string;
  ns: string;
  url: string;
  /** `creating` until the restore finished; `dropping` once a drop started (or failed). */
  state: 'creating' | 'ready' | 'dropping';
  /** The caller's worktree, the same holder name `up` uses. */
  holder: string;
  /** The agent tether, when the caller named one (`--holder-pid`, BACKLOT_HOLDER_PID, or `db with`'s own CLI). */
  holderPid?: number;
  holderStart?: number;
  /** The already-templated drop command (command-family drivers). */
  dropCmd?: string;
  /** Where it runs: the worktree, or the state root when that is gone. */
  dropCwd?: string;
  /** What to delete instead (sqlite): the copy's own directory under the state root. */
  dropPath?: string;
  createdAt: number;
  dropAttempts: number;
  nextDropAt: number;
  /** The template it was restored from (`<stack>/<marker>`), so retention keeps it (decision 0037). */
  template?: string;
  /**
   * `runly db with`'s command (decision 0039): its pid and start time, and its
   * process group when it runs in its own. A copy dropped while the command
   * still runs — its CLI was killed — takes the command down first, so
   * nothing keeps working against a dropped database.
   */
  child?: { pid: number; start?: number; pgid?: number };
}

function parseChild(raw: unknown): DbCopyRow['child'] {
  if (typeof raw !== 'string') return undefined;
  try {
    const c = JSON.parse(raw) as { pid?: unknown; start?: unknown; pgid?: unknown };
    if (typeof c.pid !== 'number') return undefined;
    return { pid: c.pid, ...(typeof c.start === 'number' ? { start: c.start } : {}), ...(typeof c.pgid === 'number' ? { pgid: c.pgid } : {}) };
  } catch {
    return undefined;
  }
}

export class Journal {
  private db: DatabaseSync;

  constructor(path = journalPath()) {
    this.db = new DatabaseSync(path);
    // Concurrent readers exist (tests and tools open the journal directly while
    // the daemon runs), and without a busy timeout any overlap is an immediate
    // SQLITE_BUSY rather than a short wait. Set before the first read below.
    this.db.exec('PRAGMA busy_timeout = 5000');
    // Refuse a journal from the FUTURE before touching it. A newer runly may
    // have written rows whose semantics this build does not know, and the
    // failure mode is silent: we would read a default where the newer build
    // stored meaning, then write that misreading back as truth. Checked before
    // any DDL so a journal we do not understand is never modified at all.
    const stamped = Number(
      (this.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0,
    );
    if (stamped > JOURNAL_SCHEMA_VERSION) {
      throw new BrokerError(
        'infra-error',
        `journal at ${path} was written by a newer runly (schema ${stamped}; this build understands ${JOURNAL_SCHEMA_VERSION}) — ` +
          `run the newer runly, upgrade this one, or point BACKLOT_STATE_DIR at a different state root`,
        'journal',
      );
    }
    // Journals older than schema 4 (runly before 0.16) carried data-only
    // environments, path-spelled stack identities and the projected worktree
    // copies whose migrations lived here until 0.18. They are gone: such a
    // journal is refused untouched rather than half-read (decision 0042).
    // Schema 4 itself is still read: 4 -> 5 changes no table, only which daemons
    // may open the file (decision 0046), so it is upgraded by the stamp below.
    // 5 -> 6 moves the lease's single preview into `lease_previews` (below).
    const hasTables = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'envs'").get() !== undefined;
    if (hasTables && stamped < OLDEST_READABLE_JOURNAL_SCHEMA) {
      throw new BrokerError(
        'infra-error',
        `journal at ${path} has schema ${stamped}, older than this build reads (${JOURNAL_SCHEMA_VERSION}) — ` +
          `upgrade through runly 0.18 first (it migrates the journal), or point BACKLOT_STATE_DIR at a fresh state root`,
        'journal',
      );
    }
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS envs (
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
      CREATE TABLE IF NOT EXISTS leases (
        id TEXT PRIMARY KEY, env_id TEXT NOT NULL, kind TEXT NOT NULL,
        holder TEXT NOT NULL, hygiene TEXT NOT NULL, expires_at INTEGER NOT NULL,
        holder_pid INTEGER, holder_start INTEGER
      );
      CREATE TABLE IF NOT EXISTS lease_previews (
        lease_id TEXT NOT NULL, service TEXT NOT NULL,
        url TEXT, pid INTEGER, start INTEGER, port INTEGER, restore TEXT,
        PRIMARY KEY (lease_id, service)
      );
      CREATE TABLE IF NOT EXISTS counters (
        stack TEXT PRIMARY KEY, next_env INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS db_copies (
        name TEXT PRIMARY KEY, stack TEXT NOT NULL, stack_root TEXT NOT NULL,
        datastore TEXT NOT NULL, preset TEXT NOT NULL, ns TEXT NOT NULL, url TEXT NOT NULL,
        state TEXT NOT NULL, holder TEXT NOT NULL, holder_pid INTEGER, holder_start INTEGER,
        drop_cmd TEXT, drop_cwd TEXT, drop_path TEXT,
        created_at INTEGER NOT NULL, drop_attempts INTEGER NOT NULL DEFAULT 0,
        next_drop_at INTEGER NOT NULL DEFAULT 0, template TEXT, child TEXT
      );
    `);
    // A schema-4 journal written by 0.16 or 0.17 lacks the columns added since
    // (additive: no schema bump). Only the duplicate-column case is benign.
    for (const [table, col] of [['envs', 'activity TEXT'], ['envs', 'drop_recipes TEXT'], ['envs', 'templates TEXT'], ['db_copies', 'template TEXT'], ['db_copies', 'child TEXT']] as const) {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`);
      } catch (err) {
        if (!/duplicate column name/i.test(String((err as Error).message ?? err))) throw err;
      }
    }
    if (stamped < JOURNAL_SCHEMA_VERSION) {
      // One transaction with the stamp: a kill mid-migration must leave a
      // journal that migrates again, never one stamped 6 whose preview still
      // sits in the old columns, where nothing reads it any more.
      this.withTx(() => {
        this.migrateLeasePreviews();
        this.db.exec(`PRAGMA user_version = ${JOURNAL_SCHEMA_VERSION}`);
      });
    }
  }

  /**
   * Schema 5 -> 6 (decision 0052): a lease's one preview moves from its
   * `preview_*` columns to a `lease_previews` row keyed by its service — the
   * live tunnel (pid, start, url, port) and the restore record alike, so the
   * next daemon can still reap the tunnel and publish it again. The old
   * columns are cleared, not dropped.
   */
  private migrateLeasePreviews(): void {
    const cols = new Set((this.db.prepare('PRAGMA table_info(leases)').all() as Array<{ name: string }>).map((c) => c.name));
    if (!cols.has('preview_pid')) return;
    const restoreCol = cols.has('preview_restore');
    const rows = this.db.prepare(
      `SELECT id, preview_service, preview_url, preview_pid, preview_start, preview_port${restoreCol ? ', preview_restore' : ''} FROM leases`,
    ).all() as Array<Record<string, unknown>>;
    const insert = this.db.prepare(
      `INSERT INTO lease_previews (lease_id, service, url, pid, start, port, restore) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(lease_id, service) DO NOTHING`,
    );
    for (const r of rows) {
      const restore = parseJson<PreviewRestore>(r.preview_restore);
      const pid = (r.preview_pid as number | null) ?? null;
      if (pid === null && !restore) continue;
      // A live tunnel migrates even when nothing names its service: the pid
      // is what lets the next daemon reap it.
      const service = (r.preview_service as string | null) ?? restore?.service ?? '?';
      insert.run(
        r.id as string, service, (r.preview_url as string | null) ?? null, pid, (r.preview_start as number | null) ?? null,
        (r.preview_port as number | null) ?? null, restore ? JSON.stringify({ ...restore, service }) : null,
      );
    }
    this.db.exec(
      `UPDATE leases SET preview_service=NULL, preview_url=NULL, preview_pid=NULL, preview_start=NULL, preview_port=NULL${restoreCol ? ', preview_restore=NULL' : ''}`,
    );
  }

  /**
   * One real sqlite transaction around a multi-statement write. Each of these
   * sequences used to be N independent writes, so a daemon SIGKILLed between
   * them left a half-state on disk — deleteEnv's env-gone-lease-left was the
   * reviewed case. The sweeper tolerates those half-states (journals outlive
   * releases); this stops new ones being minted. BEGIN IMMEDIATE takes the
   * write lock up front, so the sequence can't interleave with the concurrent
   * writers that busy_timeout exists for either.
   */
  private withTx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* sqlite may already have rolled back on error */
      }
      throw err;
    }
  }

  private rowToEnv(r: Record<string, unknown>): EnvRow {
    return {
      id: r.id as string,
      stack: r.stack as string,
      stackRoot: r.stack_root as string,
      state: r.state as EnvState,
      root: r.root as string,
      ports: JSON.parse(r.ports as string),
      datastoreNs: JSON.parse(r.datastore_ns as string),
      fingerprints: JSON.parse(r.fingerprints as string),
      presets: JSON.parse(r.presets as string),
      bindCount: r.bind_count as number,
      createdAt: r.created_at as number,
      lastUsedAt: r.last_used_at as number,
      servicePids: parseServicePids(r.service_pids as string),
      failStreak: (r.fail_streak as number) ?? 0,
      activeServices: r.active_services ? (JSON.parse(r.active_services as string) as string[]) : undefined,
      activity: parseJson(r.activity),
      dropRecipes: parseJson(r.drop_recipes),
      templates: parseJson(r.templates),
    };
  }

  saveEnv(e: EnvRow): void {
    this.db
      .prepare(
        `INSERT INTO envs (id, stack, stack_root, state, root, ports, datastore_ns, fingerprints, presets, bind_count, created_at, last_used_at, service_pids, fail_streak, active_services, drop_recipes, templates)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET state=excluded.state, ports=excluded.ports,
           datastore_ns=excluded.datastore_ns, fingerprints=excluded.fingerprints,
           presets=excluded.presets, bind_count=excluded.bind_count,
           last_used_at=excluded.last_used_at, service_pids=excluded.service_pids,
           fail_streak=excluded.fail_streak, active_services=excluded.active_services,
           drop_recipes=COALESCE(excluded.drop_recipes, envs.drop_recipes),
           templates=COALESCE(excluded.templates, envs.templates)`,
      )
      .run(
        e.id, e.stack, e.stackRoot, e.state, e.root,
        JSON.stringify(e.ports), JSON.stringify(e.datastoreNs), JSON.stringify(e.fingerprints),
        JSON.stringify(e.presets), e.bindCount, e.createdAt, e.lastUsedAt, JSON.stringify(e.servicePids),
        e.failStreak, e.activeServices ? JSON.stringify(e.activeServices) : null,
        e.dropRecipes ? JSON.stringify(e.dropRecipes) : null, e.templates ? JSON.stringify(e.templates) : null,
      );
  }

  /**
   * Record the proxy's activity clocks (decision 0035). Its own statement, so
   * a snapshot saved by a verb can never roll them back, and merged so a
   * clock only moves forward.
   */
  saveActivity(id: string, activity: Record<string, number>): void {
    const row = this.db.prepare('SELECT activity FROM envs WHERE id = ?').get(id) as { activity?: string | null } | undefined;
    if (!row) return;
    const merged: Record<string, number> = { ...(parseJson<Record<string, number>>(row.activity) ?? {}) };
    for (const [k, v] of Object.entries(activity)) merged[k] = Math.max(merged[k] ?? 0, v);
    this.db.prepare('UPDATE envs SET activity = ? WHERE id = ?').run(JSON.stringify(merged), id);
  }

  getEnv(id: string): EnvRow | undefined {
    const r = this.db.prepare('SELECT * FROM envs WHERE id = ?').get(id);
    return r ? this.rowToEnv(r as Record<string, unknown>) : undefined;
  }

  envsForStack(stack: string): EnvRow[] {
    return (this.db.prepare('SELECT * FROM envs WHERE stack = ? ORDER BY id').all(stack) as Record<string, unknown>[]).map(
      (r) => this.rowToEnv(r),
    );
  }

  allEnvs(): EnvRow[] {
    return (this.db.prepare('SELECT * FROM envs ORDER BY id').all() as Record<string, unknown>[]).map((r) =>
      this.rowToEnv(r),
    );
  }

  private rowToDbCopy(r: Record<string, unknown>): DbCopyRow {
    return {
      name: r.name as string,
      stack: r.stack as string,
      stackRoot: r.stack_root as string,
      datastore: r.datastore as string,
      preset: r.preset as string,
      ns: r.ns as string,
      url: r.url as string,
      state: r.state as DbCopyRow['state'],
      holder: r.holder as string,
      holderPid: (r.holder_pid as number | null) ?? undefined,
      holderStart: (r.holder_start as number | null) ?? undefined,
      dropCmd: (r.drop_cmd as string | null) ?? undefined,
      dropCwd: (r.drop_cwd as string | null) ?? undefined,
      dropPath: (r.drop_path as string | null) ?? undefined,
      createdAt: r.created_at as number,
      dropAttempts: (r.drop_attempts as number) ?? 0,
      nextDropAt: (r.next_drop_at as number) ?? 0,
      template: (r.template as string | null) ?? undefined,
      child: parseChild(r.child),
    };
  }

  saveDbCopy(c: DbCopyRow): void {
    this.db
      .prepare(
        `INSERT INTO db_copies (name, stack, stack_root, datastore, preset, ns, url, state, holder, holder_pid, holder_start,
           drop_cmd, drop_cwd, drop_path, created_at, drop_attempts, next_drop_at, template, child)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(name) DO UPDATE SET state=excluded.state, drop_attempts=excluded.drop_attempts,
           next_drop_at=excluded.next_drop_at, template=COALESCE(excluded.template, db_copies.template),
           child=COALESCE(excluded.child, db_copies.child)`,
      )
      .run(
        c.name, c.stack, c.stackRoot, c.datastore, c.preset, c.ns, c.url, c.state, c.holder,
        c.holderPid ?? null, c.holderStart ?? null, c.dropCmd ?? null, c.dropCwd ?? null, c.dropPath ?? null,
        c.createdAt, c.dropAttempts, c.nextDropAt, c.template ?? null, c.child ? JSON.stringify(c.child) : null,
      );
  }

  getDbCopy(name: string): DbCopyRow | undefined {
    const r = this.db.prepare('SELECT * FROM db_copies WHERE name = ?').get(name);
    return r ? this.rowToDbCopy(r as Record<string, unknown>) : undefined;
  }

  allDbCopies(): DbCopyRow[] {
    return (this.db.prepare('SELECT * FROM db_copies ORDER BY created_at, name').all() as Record<string, unknown>[]).map((r) =>
      this.rowToDbCopy(r),
    );
  }

  deleteDbCopy(name: string): void {
    this.db.prepare('DELETE FROM db_copies WHERE name = ?').run(name);
  }

  deleteEnv(id: string): void {
    // Atomic: a kill between these two deletes left a lease naming an env row
    // that no longer existed (the sweeper prunes that half-state as backstop).
    this.withTx(() => {
      this.db.prepare('DELETE FROM envs WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM lease_previews WHERE lease_id IN (SELECT id FROM leases WHERE env_id = ?)').run(id);
      this.db.prepare('DELETE FROM leases WHERE env_id = ?').run(id);
    });
  }

  /**
   * A per-stack env sequence that NEVER reuses a number, even after envs are
   * reaped — so a recycled env's id can't collide with a live one. Monotonic
   * in the journal, survives daemon restarts.
   */
  nextEnvSeq(stack: string): number {
    // Atomic read-modify-write: a foreign writer landing between the SELECT
    // and the UPDATE would hand the same "never reused" number out twice.
    return this.withTx(() => {
      this.db.prepare('INSERT INTO counters (stack, next_env) VALUES (?, 1) ON CONFLICT(stack) DO NOTHING').run(stack);
      const row = this.db.prepare('SELECT next_env FROM counters WHERE stack = ?').get(stack) as { next_env: number };
      const seq = row.next_env;
      this.db.prepare('UPDATE counters SET next_env = next_env + 1 WHERE stack = ?').run(stack);
      return seq;
    });
  }

  /** Activity, NOT lease renewal: keeps idle reclamation honest without extending ownership. */
  touchEnv(id: string): void {
    this.db.prepare('UPDATE envs SET last_used_at = ? WHERE id = ?').run(Date.now(), id);
  }

  /** Update just the recorded service pids (auto-restart keeps recovery honest). */
  updateServicePids(id: string, pids: Record<string, ServicePid>): void {
    this.db.prepare('UPDATE envs SET service_pids = ? WHERE id = ?').run(JSON.stringify(pids), id);
  }

  saveLease(l: Omit<LeaseRow, 'previews'>): void {
    this.db
      .prepare(
        `INSERT INTO leases (id, env_id, kind, holder, hygiene, expires_at, holder_pid, holder_start)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at, hygiene=excluded.hygiene,
           holder_pid=excluded.holder_pid, holder_start=excluded.holder_start`,
      )
      .run(
        l.id,
        l.envId,
        l.kind,
        l.holder,
        l.hygiene,
        l.expiresAt,
        l.holderPid ?? null,
        l.holderStart ?? null,
      );
  }

  /**
   * Record the live tunnel of one service's preview (decision 0052). A lease
   * that is gone by now records nothing: its row is what names the tunnel,
   * and the caller re-reads the lease before it writes.
   */
  setLeasePreview(id: string, service: string, live: { url: string; pid: number; start?: number; port: number }): void {
    this.db.prepare(
      `INSERT INTO lease_previews (lease_id, service, url, pid, start, port)
         SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM leases WHERE id = ?)
       ON CONFLICT(lease_id, service) DO UPDATE SET url=excluded.url, pid=excluded.pid, start=excluded.start, port=excluded.port`,
    ).run(id, service, live.url, live.pid, live.start ?? null, live.port, id);
  }

  /**
   * Forget one service's preview tunnel — compare-and-swap on the pid.
   *
   * Every caller reached here holding a lease SNAPSHOT, so an unconditional
   * clear let a slow one wipe the record of a tunnel someone else had already
   * published in its place. That pid is then unnameable, and an unnameable
   * preview pid is a public, unauthenticated URL that serves forever. Passing
   * the pid that was actually stopped makes a stale caller a no-op; the
   * pid-less form is only for a row that is being deleted outright. Other
   * services' previews on the same lease are never touched.
   */
  clearLeasePreview(id: string, service: string, stoppedPid?: number): void {
    const cols = 'url=NULL, pid=NULL, start=NULL, port=NULL';
    if (stoppedPid === undefined) this.db.prepare(`UPDATE lease_previews SET ${cols} WHERE lease_id=? AND service=?`).run(id, service);
    else this.db.prepare(`UPDATE lease_previews SET ${cols} WHERE lease_id=? AND service=? AND pid=?`).run(id, service, stoppedPid);
    this.dropEmptyPreview(id, service);
  }

  /** Record (or, with null, forget) what a restart re-publishes for this service's preview (decisions 0045, 0052). */
  setLeasePreviewRestore(id: string, service: string, restore: PreviewRestore | null): void {
    if (restore) {
      this.db.prepare(
        `INSERT INTO lease_previews (lease_id, service, restore)
           SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM leases WHERE id = ?)
         ON CONFLICT(lease_id, service) DO UPDATE SET restore=excluded.restore`,
      ).run(id, service, JSON.stringify(restore), id);
      return;
    }
    this.db.prepare('UPDATE lease_previews SET restore=NULL WHERE lease_id=? AND service=?').run(id, service);
    this.dropEmptyPreview(id, service);
  }

  /** A row with neither a tunnel nor a publication to restore says nothing. */
  private dropEmptyPreview(id: string, service: string): void {
    this.db.prepare('DELETE FROM lease_previews WHERE lease_id=? AND service=? AND pid IS NULL AND restore IS NULL').run(id, service);
  }

  private rowToPreview(r: Record<string, unknown>): LeasePreview {
    return {
      service: r.service as string,
      url: (r.url as string | null) ?? undefined,
      pid: (r.pid as number | null) ?? undefined,
      start: (r.start as number | null) ?? undefined,
      port: (r.port as number | null) ?? undefined,
      restore: parseJson<PreviewRestore>(r.restore),
    };
  }

  private previewsOf(leaseId: string): Record<string, LeasePreview> {
    const out: Record<string, LeasePreview> = {};
    for (const r of this.db.prepare('SELECT * FROM lease_previews WHERE lease_id = ? ORDER BY service').all(leaseId) as Record<string, unknown>[]) {
      const p = this.rowToPreview(r);
      out[p.service] = p;
    }
    return out;
  }

  private rowToLease(r: Record<string, unknown>, previews?: Record<string, LeasePreview>): LeaseRow {
    return {
      id: r.id as string,
      envId: r.env_id as string,
      kind: 'session' as LeaseKind,
      holder: r.holder as string,
      hygiene: r.hygiene as Hygiene,
      expiresAt: r.expires_at as number,
      holderPid: (r.holder_pid as number | null) ?? undefined,
      holderStart: (r.holder_start as number | null) ?? undefined,
      previews: previews ?? this.previewsOf(r.id as string),
    };
  }

  leaseForHolder(holder: string, stack: string): LeaseRow | undefined {
    const rows = this.db.prepare(
      `SELECT l.* FROM leases l JOIN envs e ON e.id = l.env_id WHERE l.holder = ? AND e.stack = ?`,
    ).all(holder, stack) as Record<string, unknown>[];
    if (rows.length > 1) {
      throw new BrokerError(
        'env-error',
        `ambiguous leases for holder '${holder}': ${rows.map((r) => r.env_id).join(', ')}; inspect 'runly status', then retire one with 'runly pool recycle <envId> --force' — that destroys the selected environment and its data and ends its lease`,
        'lease',
      );
    }
    return rows[0] ? this.rowToLease(rows[0]) : undefined;
  }

  leaseForEnv(envId: string): LeaseRow | undefined {
    const r = this.db.prepare('SELECT * FROM leases WHERE env_id = ?').get(envId);
    return r ? this.rowToLease(r as Record<string, unknown>) : undefined;
  }

  allLeases(): LeaseRow[] {
    const previews = new Map<string, Record<string, LeasePreview>>();
    for (const r of this.db.prepare('SELECT * FROM lease_previews ORDER BY lease_id, service').all() as Record<string, unknown>[]) {
      const p = this.rowToPreview(r);
      const of = previews.get(r.lease_id as string) ?? {};
      of[p.service] = p;
      previews.set(r.lease_id as string, of);
    }
    return (this.db.prepare('SELECT * FROM leases').all() as Record<string, unknown>[]).map((r) =>
      this.rowToLease(r, previews.get(r.id as string) ?? {}),
    );
  }

  deleteLease(id: string): void {
    this.withTx(() => {
      this.db.prepare('DELETE FROM leases WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM lease_previews WHERE lease_id = ?').run(id);
    });
  }

  /** Shift every deadline by `ms` — the sleep pardon (decision 0009). */
  pardon(ms: number): void {
    // Atomic: a kill between these left leases pardoned but idle clocks not,
    // so a machine that slept woke to premature quiesces.
    this.withTx(() => {
      this.db.prepare('UPDATE leases SET expires_at = MIN(expires_at + ?, ?) WHERE expires_at < ?').run(ms, NO_LEASE_EXPIRY, NO_LEASE_EXPIRY);
      this.db.prepare('UPDATE envs SET last_used_at = last_used_at + ?').run(ms);
    });
  }
}
