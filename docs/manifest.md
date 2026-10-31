# Manifest reference

`runly.yml` or `runly.yaml` at the repo root ([JSON Schema](../schema/runly.schema.json)). Commands
run under `sh` in the worktree; write POSIX sh.

| Field | Meaning |
| --- | --- |
| `name` | Stack name (`a-z0-9-`). Required. |
| `services.<svc>.run` | The supervised command. Required. |
| `services.<svc>.build` | Command run before the service starts, on every `up`. `{ run, when: [globs], serial }`: `when` skips it while the matched files are unchanged since the last successful build and its `outputs:` are still what that build left; `serial: true` runs it alone. |
| `services.<svc>.outputs` | Globs the build produces; a running service restarts only when they changed. `{ paths, compare: stat \| content }`. None declared = restart after every build. |
| `services.<svc>.port` | Symbolic port name. Omit for a portless worker. |
| `services.<svc>.env` | Environment variables; values may use templates (below). |
| `services.<svc>.env_from` | Caller variables to pass in: `NAME: required \| optional`. Not `BACKLOT_*`. |
| `services.<svc>.cwd` | Working directory, relative to the repo root. |
| `services.<svc>.ready` | Readiness: `http` (path answering 200), `log` (regex), or `cmd` (exit 0); `timeout` seconds (120). Not templated: `cmd` runs in the repo root (not the service's `cwd`) with the service's environment, so it reads templated values from its `env:` (`$PORT`, not `{{ports.web}}`). |
| `services.<svc>.fatal_logs` | Regex that fails the start at once when it appears in the log. |
| `services.<svc>.depends_on` | Services that must be ready first. A service starts as soon as its own `depends_on` are ready; services that do not depend on each other start at once (an `up`, a restart after a restore, a wake). |
| `services.<svc>.idle` | Idle time before the service is stopped (`90s`, `30m`, `2h`, seconds, or `never`). Default 5 minutes. |
| `services.<svc>.resources` | Cost for the load budget: `{ memory, cpu, build: { memory, cpu } }`. Default 512M / 0.5 cpu running, 1G / 1 cpu building. |
| `datastores.<ds>.driver` | `sqlite`, `postgres`, `mssql`, `mysql`, `redis`, `mongodb` or `elasticsearch`. Required. Every driver but sqlite is command-driven: runly runs the commands below and embeds no client. |
| `datastores.<ds>.create` | Creates and seeds a namespace; `{{ns}}`, `{{preset}}`. |
| `datastores.<ds>.drop` | Drops a namespace; `{{ns}}`. Needed for `runly db` copies of a server datastore. |
| `datastores.<ds>.template_restore` | Restores a baked template into a namespace; `{{template}}`, `{{ns}}`. Server drivers. |
| `datastores.<ds>.template` | `true`: bake a template file and restore by copy. sqlite only. |
| `datastores.<ds>.url` | Connection string handed to services; `{{ns}}`. Required for server drivers. |
| `datastores.<ds>.probe` | `host:port` checked before anything starts (unreachable = infra-error). |
| `datastores.<ds>.server` | `external` (the only value): runly never runs a database server. |
| `datastores.<ds>.presets` | Named seed states. |
| `datastores.<ds>.default_preset` | The preset a new datastore is created with (else the first preset). A name, or `{ session, run }` read as one value. |
| `datastores.<ds>.ephemeral` | `true`: no presets or templates; a reset runs `drop:` as a flush (Redis-class); `create:` runs only when the namespace is first made. Required for `elasticsearch`. |
| `datastores.<ds>.derived_from` | Another datastore this ephemeral one is computed from (a search index fed from the database). Whenever a bind restores the source — creates it, resets it, reloads it with `--preset`, or re-restores it for a new template — it also flushes this one with `drop:`, and restarts the running services that template either. One level: the source may not be derived itself. |
| `datastores.<ds>.share_templates` | `false`: keep this datastore's templates per worktree. Default: a template keyed by an `@rebake-template` rule is baked once and shared by every worktree of the same stack name on this machine; `--pristine` bakes a private one for its worktree. |
| `datastores.<ds>.copies_only` | `true`: never provisioned for an environment; only the source of `runly db new\|with` copies (template baked on the first copy). No service may template it; `ctx` does not list it. |
| `datastores.<ds>.list` | Command printing the namespaces on the server, one per line; read only by `runly pool doctor`. Not templated. `elasticsearch` may print index or alias names: each is cut at its first `-` or `.` to the namespace, and a name under a namespace an environment, copy or template uses is never an orphan. |
| `appliances.<name>` | A shared backing server: `probe` (required), `start` (run once when the probe fails), `stop` (only for `runly appliance stop`), `ready`, `timeout` (60), `resources`. |
| `upkeep[]` | `{ when: <path or glob>, run: <cmd>, timeout: <s>, outputs: <path or list> }`: runs when the matched files' content changed since it last ran in this worktree, or when a declared `outputs` path is missing (a `git clean` removed it). `runly destroy` forgets the rules that declare no `outputs`, so they run again on the next `up`. `run: "@rebake-template <ds>"` makes the matched files part of that datastore's template key: changed content gets a new template (baked once, then reused) and reloads the store; `--pristine` rebakes. Timeout 300 s. `when:` may reach outside the worktree (see below); `run:` always runs in the worktree, `outputs:` stay inside it. |
| `builds` | `parallel` (default): builds run in `depends_on` waves, each wave at once. `serial`: one at a time, in manifest order. |
| `caches` | Build and install output in the worktree (`node_modules`, `**/obj`); never an upkeep trigger. |
| `sync.include` | Git-ignored files an upkeep `when:` may still match (`.env.local`). |
| `auth.logins` | One `{ user, password, role, description }` or a list; the first is the primary login. |
| `auth.token` | Command printing a token on stdout; `{{role}}`. |
| `preview.publisher` | `cloudflare-quick` (default), `cloudflare-named` or `tailscale`. |
| `preview.domain`, `preview.prefix` | `cloudflare-named`: the zone, and the hostname suffix (default: the environment id). |
| `preview.https_port` | `tailscale`: the tailnet HTTPS port (default: derived per environment and service). |
| `preview.forbidden` | `true`: `runly preview` is refused. |

Templates are resolved in `services.<svc>.run`, `services.<svc>.build` (its
command) and the values of `services.<svc>.env`, and in `auth.token` (which also
gets `{{role}}`); a `{{…}}` there that names no variable below (a typo, an
undeclared port, service or datastore) is refused when the manifest is loaded.
Nothing else is templated — not `ready`, `cwd`, `appliances`, `preview`, nor
upkeep `run:`; upkeep `when:` accepts exactly one variable, a leading
`{{main_worktree}}` (below). Datastore commands take only their own variables:
`url`, `drop` `{{ns}}`; `create` `{{ns}}`, `{{preset}}`; `template_restore`
`{{template}}`, `{{ns}}`.

| Variable | Value |
| --- | --- |
| `{{ports.<port>}}` | In a service's own `run:` and `env:`, the internal port it must listen on; everywhere else the stable public one. |
| `{{public_ports.<port>}}` | Always the public port. |
| `{{services.<svc>.url}}` | `http://localhost:<public port>`. |
| `{{datastores.<ds>.url}}`, `{{datastores.<ds>.ns}}` | The datastore's connection string and namespace in this environment. |
| `{{datastores.<ds>.preset}}` | The preset the datastore holds: after `up --preset ds=NAME`, `NAME`; after `reset-data`, the preset it held (or the one named); before its first restore, the default. A service that templates it restarts when the datastore is reloaded. A `build:` runs before the restore and sees the preset a named `--preset` is about to restore. `ephemeral` datastores hold `default`. `runly db` copies never change it; `db with` passes the copy's preset as `RUNLY_DB_PRESET`. |
| `{{env.id}}` | The environment id (`<stack>-<hash>-e<n>`, mixed case): stable for the environment's life; a new environment of the worktree (after `destroy`) gets a new one. Also `RUNLY_ENV_ID` in `ctx --env` and `exec`. |
| `{{env.slug}}` | `{{env.id}}` as a lowercase `[a-z0-9-]` name of at most 63 bytes, with a hash of the id appended when lowering changed it — for index, container or host names. |

Top-level `outputs`, `checks` (with a warning), `sync.keep`, `watch_run` and
`hot_reload` are accepted and ignored.

## MongoDB and Elasticsearch

Both are command-driven, like postgres: the manifest supplies the commands
(`mongosh`, `mongodump`/`mongorestore`, `curl`), runly supplies the names.

- `mongodb`: `{{ns}}` is a database name, `backlot_<env id>_<ds>`, lowercased,
  with a hash of the original appended when lowering changed it (MongoDB
  refuses two databases whose names differ only in case), cut to 63 bytes with
  that hash kept. Template databases follow the same rule. Presets, templates,
  `default_preset`, `runly db` copies and `list:` work as for postgres.
- `elasticsearch`: `{{ns}}` is a lowercase index-name prefix built the same way.
  It must be `ephemeral: true` (no presets, no templates); usually it is
  `derived_from` the datastore its indices are fed from. Name indices and
  aliases `{{ns}}-<name>` or `{{ns}}.<name>`; `drop:` deletes those, by name
  (Elasticsearch refuses wildcard deletes by default).

```yaml
datastores:
  mongo:
    driver: mongodb
    probe: 127.0.0.1:27017
    url: mongodb://127.0.0.1:27017/{{ns}}
    presets: [full, demo]
    create: node tools/seed.js --db {{ns}} --preset {{preset}}
    template_restore: >-
      mongodump --uri mongodb://127.0.0.1:27017 --db {{template}} --archive |
      mongorestore --uri mongodb://127.0.0.1:27017 --archive --drop --nsFrom '{{template}}.*' --nsTo '{{ns}}.*'
    drop: mongosh mongodb://127.0.0.1:27017 --quiet --eval 'db.getSiblingDB("{{ns}}").dropDatabase()'
    list: mongosh mongodb://127.0.0.1:27017 --quiet --eval 'db.adminCommand({listDatabases:1,nameOnly:true}).databases.forEach(d=>print(d.name))'
  search:
    driver: elasticsearch
    ephemeral: true
    derived_from: mongo
    probe: 127.0.0.1:9200
    url: http://127.0.0.1:9200
    drop: >-
      i=$(curl -fsS 'http://127.0.0.1:9200/_cat/indices/{{ns}}-*,{{ns}}.*?h=index&expand_wildcards=all' | tr -d ' ' | paste -sd, -);
      [ -z "$i" ] || curl -fsS -X DELETE "http://127.0.0.1:9200/$i" >/dev/null
    list: curl -fsS 'http://127.0.0.1:9200/_cat/indices?h=index&expand_wildcards=all'
```

A datastore lives in an environment under the name its current manifest
entry gives it. Changing what decides that name — switching an existing
datastore to `mongodb` from another driver, say — restores it under the new
name on the next `up` (with the preset it held) and drops the old namespace
with the drop recorded for it; `pool doctor` also reports mixed-case leftovers
on a `mongodb` or `elasticsearch` server as runly's.

## Upkeep triggers outside the worktree

A `when:` normally names worktree files, as git lists them. It may also name
files elsewhere — data another checkout provides:

| Form | Resolved against |
| --- | --- |
| `../other/data/**` | the worktree (the stack root) |
| `/srv/exports/**` | absolute |
| `~/exports/**` | the daemon user's home |
| `{{main_worktree}}/../other/data/**` | the repository's main worktree — the same directory for every linked worktree, however deep (`.worktree/<name>`); for a bare repository with linked worktrees, the directory holding it (`proj/.bare` → `proj`). The form to commit. Only at the start of `when:`; no other `{{…}}` is allowed there. |

Such files are found by walking the disk from the glob's literal directory, not
through git, and are recorded by absolute path, so linked worktrees compute the
same template key and share the template. The walk never starts at `/`, the
worktree or an ancestor of it (that would cover the worktree and its siblings),
never enters `.git` or `node_modules`, follows no symlink below the glob's
literal directory, and fails the bind with a work-error past 20000 entries. A
symlink in the literal directory's own path (the directory itself or a
component above it) is followed: the walk runs in the real directory, the
worktree/ancestor refusal is checked on the real paths, and files keep the path
as written. A directory that does not exist matches nothing. When the main
worktree cannot be determined (no git checkout), `{{main_worktree}}` is the
stack root, with a warning in `runly status`, and is asked again on the
next `up`. Only upkeep `when:` reaches outside; build `when:`, `outputs:`,
`caches:` and `sync.include` stay inside the worktree.
