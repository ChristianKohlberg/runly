# 0051. Services start concurrently, each as soon as its own `depends_on` are ready; a failed start stops the call's other starts at once; templates are checked at load

- Status: Accepted
- Date: 2026-10
- Amends: [0035](0035-services-idle-on-their-own-clock-and-wake-on-demand.md)
  — how a wake starts its `depends_on` closure;
  [0039](0039-teardown-keeps-templates-a-leased-environment-survives-a-crash-loop.md)
  — what a failed boot does to the starts beside it
- Context: a consumer's stack has an index sync with no `depends_on` that
  logs ready only after minutes of indexing, and a portal that depends only
  on its API. The start loop took the services of one round one after
  another, each awaiting readiness, so the portal waited for the sync after
  every `up`, every `reset-data` and every restart after a preset reload.
  Starting them side by side then exposed a second gap: a start that failed
  before its readiness wait (an internal port that could not be allocated, a
  run line with a `{{…}}` typo) only marked the call failed and waited for
  its siblings to become ready or time out.

## Decision

**Each service starts as soon as its own `depends_on` are ready**, and every
start whose dependencies are ready runs at once — in a bind, in the restart
after a restore or preset reload, in a wake and in a verb's resume. A service
no one depends on never holds back another one. `depends_on` is the only
ordering runly honours; a stack that relied on manifest order between
independent services declares it.

**A failed start fails the call as one, wherever it failed.** Allocation,
templating, spawning and readiness are one fail path: a bind stops everything
it runs (`stop-all`, reaped as every `stopAll()` is), a wake or resume only
what it started (`stop-these`), and every sibling still booting stops waiting
at once (the supervisor drops the stopped service, and its readiness wait
ends on the next poll) — `up` reports in the time the failing service took,
not in its siblings' `ready.timeout`. The leased boot failure of 0039 (a
work-error of the service's own: exit, `fatal_logs`, daemonized) still stops
only that service and blocks only its dependents, in a bind.

**`{{…}}` is checked when the manifest is loaded.** Every variable in a
service's `run:`, `build:` command and `env:` values and in `auth.token`
must be one the environment has (a declared port, a service with a port, a
datastore an environment provisions, `env.id`/`env.slug`, `{{role}}` in
`auth.token`); a typo is a work-error naming the field and the variables of
that group, before anything is claimed or started.

## Consequences

- Independent services' logs interleave from the first second, and their
  start order between `up`s is not stable; `depends_on` is what to declare.
- A readiness `cmd:` probe already running when its service is stopped runs
  to its own end (bounded by the remaining `ready.timeout`) before the wait
  notices; `http:` and `log:` waits end within one poll.
- A manifest whose run line used to fail only when its service started (a
  `{{…}}` for a datastore that was removed, say) is now refused by every verb
  that loads it.
