# 0050. MongoDB and Elasticsearch datastores, derived state, environment ids in templates, and upkeep triggers outside the worktree

- Status: Accepted
- Date: 2026-10
- Amends: [0012](0012-commands-first-services.md) and
  [0016](0016-data-states-not-seeds-three-baselines-scenarios-in-tests.md) —
  which datastores exist; [0032](0032-environments-run-in-the-callers-worktree.md)
  — what an upkeep `when:` may read; [0034](0034-additive-up-database-copies-and-ps.md)
  — what a preset reload restores; [0037](0037-cleanup-by-reference-and-pool-doctor.md)
  — how `pool doctor` reads namespaces
- Context: a consumer runs per-worktree data on a shared MongoDB replica set
  and a shared Elasticsearch, both appliances (decision 0018). Its database
  has two seed states (a full export and a demo), selected per worktree; its
  search indices are computed from the database by a service of the stack.
  The export lives in a sibling checkout, and a new export must give a new
  template. None of that was expressible: no `mongodb` or `elasticsearch`
  driver, no way for a service to know which preset its database holds, no
  way to name the environment in a lowercase-only system, and an upkeep
  `when:` outside the worktree silently matched nothing.

## Decision

**Two more command drivers.** `mongodb` and `elasticsearch` join postgres,
mssql, mysql and redis: every mechanic is a repo command (`create`, `drop`,
`template_restore`, `list`), runly embeds no client (0001). The namespace
scheme is the existing one, `backlot_<env id>_<ds>`, with one change for these
two drivers: the name is **lowercase**. Elasticsearch refuses uppercase index
names; MongoDB refuses a database whose name differs from an existing one only
in case. Environment ids are mixed case (the stack id's hash is base64url), so
lowercasing alone could fold two environments onto one name — a hash of the
ORIGINAL identity is appended whenever lowering changed anything, and a name
over 63 bytes is cut in the middle keeping that hash, as before. Template
databases follow the same rule. The other drivers' names are unchanged, so no
existing namespace moves — except the namespace of a datastore whose
manifest entry moves it: a datastore exists in an environment only under the
name the CURRENT manifest gives it, so a consumer that switches a store from
a stand-in driver (`driver: mysql` running `mongosh` commands, whose names are
mixed case) to `mongodb` gets its store restored under the new name on the
next `up` (or wake), with the preset it held, and the old namespace dropped
by its recorded recipe first. `pool doctor` compares a case-folding driver's
listed names with its stack prefixes without case, so a mixed-case leftover
of such a switch is runly's to report and fix, not foreign.

**Elasticsearch is a datastore, and its state is derived.** An Elasticsearch
namespace is an index-name prefix: the stack's indices and aliases are
`{{ns}}-<name>` or `{{ns}}.<name>`, and `drop:` deletes them by name. It must
be `ephemeral: true` — no presets, no templates, a reset is the `drop:` — which
is exactly the Redis-class contract; `presets`, `default_preset` and
`template_restore` are refused on it. Ephemeral alone missed one thing: the
index is computed from another store, and `up --preset db=demo` reloads only
the named store (0034), so the index would keep the previous preset's
documents. The minimal addition is **`derived_from: <datastore>`** on an
ephemeral datastore: whenever a bind restores the source — creates it, resets
it, reloads it with a preset, re-restores it for a new template — it flushes
the derived store in the same bind, and the running services that template
either restart. One level only; the source must be an ordinary datastore an
environment has. Rebuilding the index stays the stack's business (its sync
service starts on an empty prefix). `list:` for Elasticsearch may print index
names: doctor cuts each at its first `-` or `.`, and treats a name under any
referenced prefix as referenced — a live index is never an orphan.

**`{{datastores.<ds>.preset}}`.** The preset the datastore holds, as `ctx`
already reports it: after `up --preset ds=NAME` it is NAME (and the services
that template it restart with the reload, through the existing
`{{datastores.<ds>.` user detection); after `reset-data` it is what the store
held (or the named one); before the first restore, the default. A build runs
before the restore, so its template sees the preset a named `--preset` is about
to restore. A `runly db` copy never changes it; `db with` hands its command
the copy's preset as `RUNLY_DB_PRESET`.

**`{{env.id}}` and `{{env.slug}}`.** The environment id — stable for the
environment's life, new after `destroy` — and its lowercase `[a-z0-9-]` form
of at most 63 bytes, with the same hash rule as the namespaces. Index, host and
container names can be derived without a shell.

**Upkeep `when:` may reach outside the worktree.** A `when:` that is absolute,
starts with `~/`, contains `..`, or starts with `{{main_worktree}}` (the
repository's main worktree, the parent of git's common dir — identical for
every linked worktree however deep it is nested) is resolved to an absolute
glob. Its files are found by walking the disk from the glob's literal
directory — the other tree may be no repository, or another one — and are
matched, hashed and recorded by absolute path, so the template key does not
depend on where a worktree sits and shared templates (0044) stay shared. A
worktree glob never matches an external file and the reverse. Bounds: the walk
never starts at `/`, the worktree or one of its ancestors; never enters `.git`
or `node_modules`; follows no symlink below the literal directory; and a walk
past 20000 entries fails the bind as a work-error naming the rule, instead of
hashing a tree. A symlink in the literal directory's own path is followed —
the walk runs in the real directory and the refusal is judged on real paths
(so a link cannot hide the worktree's ancestor), while files keep the path as
written. For a bare repository with linked worktrees, `{{main_worktree}}` is
the directory holding it; where git cannot tell, it is the stack root, with a
warning, and is asked again on the next bind rather than remembered. Hashes are
cached by stat in the worktree's trigger cache like any other trigger.

## Rationale

All four are small extensions of shapes runly already has — the command
family, the ephemeral contract, the template context, the trigger set — and
none adds a process runly owns: the servers stay appliances, ensured and never
owned (0018). A per-worktree database server was the other way to isolate this
data; it would make runly own compute and is out of scope here.

`derived_from` was preferred over "reset every ephemeral store on any reload"
(which would flush an unrelated cache) and over asking every such stack to
always name both stores (`--preset db=demo --preset search=default`), which is
the kind of convention a forgotten flag silently breaks.

Lowercasing only the two drivers that need it keeps every existing Postgres,
MSSQL and MySQL namespace, template and drop recipe where it is.

## Consequences

- The names of mongodb and elasticsearch namespaces end in an 8-hex hash for
  almost every environment; scripts must take them from `{{ns}}`,
  `{{datastores.<ds>.ns}}` or `ctx`, never rebuild them.
- An index not named `{{ns}}-…`/`{{ns}}.…` is not dropped by the documented
  `drop:` and is invisible to doctor's prefix reduction.
- An upkeep trigger outside the worktree is read on every bind (stat-gated);
  a large export tree costs its stat walk, bounded by the entry cap.
- Build `when:`, `outputs:`, `caches:` and `sync.include` remain inside the
  worktree.
