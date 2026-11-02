# 0052. Previews are per service within a lease

- Status: Accepted
- Date: 2026-11
- Supersedes: [0027](0027-lease-scoped-public-preview.md) — "one service per
  lease" (a second `runly preview` replaced the first);
  [0031](0031-tailscale-preview-publisher.md) — "one preview per lease still
  holds … waits for multi-service preview"
- Amends: [0045](0045-a-daemon-restart-re-publishes-the-leases-previews.md)
  — where the restore record lives and what `ctx.previewRestore` summarises;
  [0047](0047-public-preview-deadlines.md) — deadlines, renewal and reopening
  are per service
- Context: a lease could hold exactly one preview. Publishing a second service
  — the API next to its web front end, say — silently tore down the first, so a
  reviewer's link went dead without anyone being told. The workaround (0031:
  "runs two leases") was not one since 0032: a worktree has exactly one
  environment and one lease.

## Decision

**A lease has one preview per service.** `runly preview <service>` adds or
renews THAT service's preview and leaves the lease's other previews alone.
Publishing a service that already has a preview replaces its tunnel with a
fresh deadline — at the same address where the publisher can keep one
(`tailscale`'s derived or pinned port, `cloudflare-named`'s hostname;
`cloudflare-quick` cannot).

**Everything 0027, 0045 and 0047 say about "the" preview applies to each
service's preview on its own:** its own tunnel process (tagged
`preview:<service>`, its own process group, exempted from the tag-based
reapers by its own recorded leader identity), its own expiry gate and timer,
its own deadline and TTL. A successful `up` renews every live preview of the
lease and reopens each one that expired; a failed reopen is a `previewNotice`
naming the service. A bind or `down` tears down only the previews whose
service left the running set or moved its port; `preview.forbidden` tears down
all of them. A daemon restart reaps every tunnel and re-publishes every
unexpired preview, each under the environment lock. Releasing, recycling,
destroying the lease or stopping the daemon reaps all of them.

**`runly preview stop [<service>]`.** With a service, only that service's
preview is stopped and forgotten (a later `up` does not reopen it); without
one, every preview of the lease is — what `preview stop` always did. The
result is `{ stopped, service, services }`: `services` lists what was stopped,
`service` is the first of them (kept for callers written for one preview). A
name that is neither a manifest service nor a recorded preview is a
work-error; a service without a preview is `stopped: false`.

**Two services of a lease never pin the same address.** A publisher says what
its settings pin (`claim`; `tailscale`: `tailnet port N`), and the engine
refuses, as a work-error and before anything is stopped, a publish whose pinned
address another service's preview of the lease already holds — live, or
waiting for an `up` to reopen it. With `preview.https_port` in the manifest
that means the second service needs `--https-port`. A pinned port served by
anyone else stays the publisher's work-error (0031). The engine compares claims
without learning what they mean: the dialect stays in the publisher (0028).
Derived tailnet ports are per `<environment, service>` already; a derived port
that collides with an expired preview's port is only caught when that preview
reopens (a failed restore, reported as such).

**Journal schema 6.** Previews move to their own table, `lease_previews`, one
row per `<lease, service>`: the live tunnel (`url`, `pid`, `start`, `port`)
and the restore record (`restore`, the 0045 JSON). A row with neither is
deleted. Only the per-service writers touch it (`setLeasePreview`,
`clearLeasePreview` — a compare-and-swap on the pid —, `setLeasePreviewRestore`),
never `saveLease`, so a stale lease snapshot cannot erase another service's
tunnel. Deleting a lease or an environment deletes its rows in the same
transaction.

Opening a schema-5 journal migrates it in one transaction with the stamp:
each lease's `preview_*` columns (live tunnel and restore record) become a row
keyed by its service, and the old columns are cleared, not dropped. The
schema is bumped because a schema-5 daemon reads only those columns: it would
see no tunnel at all, never reap one and never restore one — and an unnamed
preview pid is a public URL that serves forever. So a schema-5 daemon refuses
the migrated journal, as every downgrade is refused.

**Context and status.** `ctx --json`:

- `previewUrls` — every LIVE preview, by service (unchanged shape; it was
  always a map).
- `previews` — new, the per-service record: `{ url, state, error?, expiresAt,
  ttlMs, publisher }` with `state` `live`, `restoring`, `failed` or `expired`.
- `previewExpiresAt` — kept as a summary for one-preview callers: the earliest
  deadline among the previews still open, else the latest one that passed;
  `null` without a preview. With one preview it is that preview's deadline,
  as before. Per service: `previews.<service>.expiresAt`.
- `previewRestore` — kept as a summary for one-preview callers: the first
  preview (by service name) that is not live, as `{ service, url, state,
  error? }`; `null` when every preview is live. Per service:
  `previews.<service>`.

`runly ps` reports each service's `preview` and prints one line per preview;
`runly status` reports `previews` per environment (and the lease's raw
`previews` record) and prints them too. The plain `ctx`/`up` summary already
showed a preview next to each service.

## Consequences

- A web front end and its API can be reviewed together from one worktree, and
  publishing one never takes the other's link away.
- More tunnels per lease means more processes the reapers must classify; they
  all go through `leasedPreviewPids`, which now walks every service's record.
- `ctx.previewExpiresAt` and `ctx.previewRestore` are lossy with more than one
  preview. Callers that care about a particular service read
  `ctx.previews.<service>`.
- A downgrade below the release that ships schema 6 refuses the journal
  (`infra-error`), like every schema bump; the remedy is the newer runly.
