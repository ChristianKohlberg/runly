# 0053. A service can template its public URL

- Status: Accepted
- Date: 2026-11
- Relates to: [0028](0028-named-preview-hostnames.md) (the publisher owns its
  dialect), [0031](0031-tailscale-preview-publisher.md) (derived tailnet
  ports), [0045](0045-a-daemon-restart-re-publishes-the-leases-previews.md)
  (pinned settings of a restore), [0052](0052-previews-are-per-service.md)
  (previews per service)
- Context: an application behind an identity provider must know the origin a
  browser reaches it at: the IdP only redirects to registered URIs, and the
  application checks `Origin`/`Host` against an allowlist. With a preview that
  origin is not `http://localhost:<port>`. No template variable named it, so a
  stack hard-coded its machine's tailnet host (`https://box.tailXXXX.ts.net`)
  into `env:` and its realm configuration, and the manifest worked on one
  machine only.

## Decision

**`{{services.<svc>.public_url}}`, for every service with a port**, resolves to
where a browser outside this machine reaches that service:

1. the URL of the service's **live preview**, when it has one;
2. else the address the stack's publisher **would** publish it at, when the
   publisher can name it in advance — a new optional publisher method,
   `address({ envId, service, settings })`, that must not publish, change or
   throw. With a restore record (an expired or not yet re-published preview,
   0045) the record's publisher and pinned settings are used, so the value is
   the address a reopen will give back;
3. else the service's **local URL** (`{{services.<svc>.url}}`).

A stack with `preview.forbidden` is never published and always gets the local
URL.

Per publisher:

- `tailscale`: `https://<machine tailnet name>:<port>`, the port pinned by
  `preview.https_port` or derived exactly as `start` derives it (0031: the
  `<environment, service>` hash, walking past ports this machine serves now).
  When tailscale is missing, not connected or cannot issue certificates, the
  local URL.
- `cloudflare-named`: `https://<service>-<prefix>.<domain>`, a function of the
  settings alone; without `preview.domain`, the local URL.
- `cloudflare-quick`: no `address` — Cloudflare picks the hostname when the
  tunnel connects — so the local URL until a preview is live. A stack that needs
  its public origin before publishing uses one of the other two.

**Fall back, never fail.** Resolving the variable never fails a start: a
service whose publisher cannot name an address starts with its local URL, which
is also what it is reachable at until someone publishes it. Refusing the start
would make every `up` depend on a tunnel tool the developer may never use.

**Resolved when a service starts, lazily.** Like every template, the value is
fixed in the service's environment when it starts; publishing later does not
restart it. Because `start` and `address` derive the same port from the same
inputs, a later `runly preview <svc>` hands out the address the service already
has. It differs only when the derived tailnet port was taken between the start
and the publish, when `--https-port` overrides the manifest, or with
`cloudflare-quick`; restarting the service (`runly down <svc> && runly up`)
picks up the live URL. Resolution may run the publisher's CLI, so it happens
only when a template names the variable: the context carries it as a lazy,
non-enumerable property, and a stack that never names it never calls the CLI.

**`ctx --json` reports `publicUrls`**: what the variable resolves to now, for
each service some template names (`{}` otherwise, for the same cost reason).
`previewUrls` and `previews` keep reporting the previews themselves.

## Consequences

- A manifest can configure an IdP or an origin allowlist from
  `{{services.<svc>.public_url}}` and works unchanged on every machine and for
  every environment of the stack.
- The publisher seam grows by one optional method; the engine still learns no
  publisher's dialect (0028).
- Configuration that is not templated — an appliance's files, such as an IdP
  realm imported at start — still cannot use the variable; a service that
  registers its redirect URIs with the IdP at start can.
- With `tailscale`, a start that names the variable runs `tailscale status` and
  `tailscale serve status` once per such service.
