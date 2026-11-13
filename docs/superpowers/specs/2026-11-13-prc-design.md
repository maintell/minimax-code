# PRC: a self-hosted gateway and web consumer for Remote Control

Status: design, awaiting review.

## 1. Problem

The Remote Control protocol in this repository assumes two pieces we do not
control: a cloud gateway that pairs a desktop producer with a consumer, and a
consumer client (the phone app). Both legs are outside this project, so a
self-hosted installation cannot use Remote Control at all.

PRC is a single self-hosted service that takes both roles:

- **Gateway** for the producer: issues bindings and one-shot tickets, terminates
  the WebSocket, assigns event ids, buffers and replays frames, and routes
  commands.
- **Consumer** for the operator: a browser console that lists sessions, sends
  messages, renders streams, and answers permission prompts.

Identity is one password. The desktop producer is pointed at PRC by configuring
a URL and that password; nothing else changes.

## 2. Goals and non-goals

Goals:

1. A desktop producer using the existing `@mavis/remote-control-bridge`
   connects to PRC and reaches feature parity with the cloud path for the command
   surface in section 8.
2. A browser is a first-class consumer: streaming output, permissions,
   session management, models, projects, pins, skills.
3. The desktop integration is additive. With no PRC configuration, the client
   behaves exactly as it does today.
4. Deployment is one Node process plus a data directory; TLS may be terminated
   by a reverse proxy.

Non-goals for this iteration:

1. Multi-tenant accounts. One password, one operator, one device fleet.
2. Desktop-as-consumer (`/phone/bindings`, controlling another desktop from the
   desktop UI).
3. Push notifications, mobile-native clients, or an offline queue for
   messages sent while the producer is disconnected.
4. Replacing the cloud for authentication, models, or updates. PRC only carries
   Remote Control traffic.

## 3. Constraints inherited from the producer

These are fixed by the shipped client and are not negotiable in the design.

| Constraint | Consequence for PRC |
| --- | --- |
| Pairing HTTP paths are `POST /pairing/code`, `GET /desktop/bindings`, `POST /unbind` under a base path | Serve the same paths under `/minimax-cloud/api/v1/remote-control` so the contract is byte-compatible |
| Pairing headers are `X-Device-Id`, `X-Producer-Type`, and a `token` header carrying a user JWT | Accept the producer's credential in `X-PRC-Password`; ignore any JWT |
| `GET /desktop/bindings` mints a fresh **60-second one-shot** ticket on every call | Every read mints and persists a new ticket; the previous one becomes unusable |
| The WebSocket endpoint is the `endpoint` field parsed as a **complete URL**, then extended with `binding_id`, `ticket`, `client_version`, `last_event_id` | Return `wss://<prc-host>/rc`; the client appends the query itself |
| The producer waits for `ctrl.hello` for 15 seconds after open | PRC must send hello immediately on connect, before any other frame |
| The producer sends `ctrl.ping` every 5 seconds and treats 15 seconds without any inbound frame as dead | Answer every ping with `ctrl.pong`; the frame also refreshes its liveness clock |
| The producer computes its replay cursor from `event_id` on any inbound frame | Every outbound frame carries a binding-scoped monotonic `event_id` |
| Frame `v` must be `1`; `id`, `type`, `ts` are required; `payload` must be an object | Validate on both directions and drop malformed frames without closing |
| Desktop frame cap floor is 128 MiB and `ctrl.hello.max_message_bytes` may only raise it | Announce exactly 128 MiB |
| The producer dedupes commands by `(commandScope, cmd.id)` for five minutes | Never reuse a `cmd.id` for a different logical request |
| `cmd.session.history` acknowledgements carry `messages_json` as a **string** | The console parses it a second time |
| Attachments are downloaded by the producer only from a hardcoded host set, `https` only, no redirects | PRC mode must inject its own fetcher, see section 10 |

## 4. Topology

```
                REST (password)      ┌───────────────────────────────────┐
producer ──────────────────────────▶ │ PRC                               │
  │                                  │  auth        binding-service      │
  └────── WS (frame protocol) ─────▶ │  producer-socket   replay-buffer  │
                                     │  command-router    event-fanout   │
browser ───── REST + WS ───────────▶ │  store (sqlite)   console         │
                                     └───────────────────────────────────┘
```

One WebSocket per producer binding, one WebSocket per browser tab. The browser
socket carries three message families: `cmd` requests, `evt` pushes, and
`permission` interactions. A single socket is chosen over SSE because
permission prompts are bidirectional and a tab needs several independent event
streams at once.

## 5. Components

| Unit | Owns | Depends on |
| --- | --- | --- |
| `auth` | Password verification, session cookies, login rate limit | store |
| `binding-service` | Binding lifecycle, ticket mint/consume, producer generation | store |
| `producer-socket` | One WebSocket: hello, auth, heartbeat, frame codec, `event_id` assignment | binding-service |
| `replay-buffer` | Bounded per-binding frame log, replay from `last_event_id`, overflow signalling | store |
| `command-router` | Consumer request to `cmd.*` frame, `ack`/`err` correlation, timeout, cancellation | producer-socket |
| `event-fanout` | Routes `evt.*` to the originating tab, broadcasts permission frames | replay-buffer |
| `attachment-service` | Upload storage, signed download URLs, expiry | store |
| `store` | SQLite: binding, ticket, event, command, attachment, session snapshot | none |
| `console` | REST API plus static frontend | all of the above |

Each unit is replaceable in isolation: `producer-socket` does not know about the
browser, `command-router` does not know about HTTP, `event-fanout` does not know
about SQLite.

## 6. Producer-facing protocol

### 6.1 Pairing and binding

Base path `/minimax-cloud/api/v1/remote-control`.

| Request | Behaviour |
| --- | --- |
| `POST /pairing/code` | Compatibility endpoint only: returns a code and a TTL so an old client cannot break, but binding is created by the authenticated binding read below, not by the code. |
| `GET /desktop/bindings?user_id=&rc_protocol_version=3` | Creates the binding on first contact for this `X-Device-Id`, mints a ticket, returns `state: bound` |
| `POST /unbind` | Deletes the binding, closes the socket, clears tickets |

Binding response:

```json
{
  "state": "bound",
  "binding_id": 1,
  "ticket": "…",
  "endpoint": "wss://prc.example.com/rc",
  "bound_at_ms": 0,
  "expires_at_ms": 0,
  "producer_generation": 1,
  "consumer_count": 1,
  "online_consumer_count": 1,
  "producer_version": "3.1.14"
}
```

`producer_generation` increments whenever a binding is recreated, so the
producer rebuilds its connection when the identity changes. `consumer_count`
counts authenticated browser sessions for the binding; `online_consumer_count`
counts those with an open socket.

Authentication: `X-PRC-Password` compared against the configured hash in
constant time. A wrong or missing password returns 401 with
`{"error":{"code":"not_authenticated"}}`, which the producer surfaces as a
credential failure rather than a crash.

### 6.2 Socket handshake

1. Client opens `wss://<endpoint>?binding_id=&ticket=&client_version=&last_event_id=`.
2. PRC validates `binding_id` and consumes the ticket. A ticket is single use;
   replaying it closes the socket with `ctrl.disconnect_reason{code:"ticket_invalid"}`.
3. PRC sends `ctrl.hello {connection_id, server_time_ms, max_message_bytes}`.
4. Client answers `ctrl.auth.complete {last_event_id?}`.
5. PRC binds the connection to the binding and delivers browser traffic.

If a second producer opens the same binding, PRC sends the established socket
`ctrl.disconnect_reason{code:"superseded"}`, closes it with code 1000, and keeps
the new one. This is how the producer learns to stop quietly instead of
retrying.

### 6.3 Frame allocation

- Every frame PRC emits carries `v: 1`, a fresh `id`, `ts`, `type`, `payload`,
  and `event_id` from a per-binding counter that survives restarts.
- `in_reply_to` is set on `ack.*` and `err.*` to the originating `cmd.id`, and on
  `evt.permission.*` frames that belong to a command-triggered turn.
- Malformed inbound frames are logged and dropped; they never close the socket.
- Frames larger than 128 MiB are rejected symmetrically.

### 6.4 Replay

`event_log` keeps the last 2000 frames per binding (24 hours). On
`ctrl.auth.complete` with `last_event_id`:

- Inside the window: send every frame with a greater `event_id`, in order, before
  any new traffic.
- Outside the window: send `ctrl.replay.overflow {}`; the producer refetches
  state instead of trusting a partial history.

Replay only applies to frames PRC emitted. Producer-to-gateway frames are never
replayed.

### 6.5 Disconnect reasons

| Direction | Code | Handling |
| --- | --- | --- |
| PRC to producer | `superseded` | another socket claimed the binding |
| PRC to producer | `ticket_invalid`, `auth_expired` | refuse the connection, do not bind |
| PRC to producer | `server_shutdown` | graceful restart |
| Producer to PRC | `app_quit` | keep the binding, mark offline |
| Producer to PRC | `daemon_unavailable` | keep the binding, mark degraded, expect a reconnect |

A producer that disappears without a reason is marked offline after the socket
closes; the binding survives so a restart reconnects without re-pairing.

## 7. Consumer API

All routes are under `/api`, require the session cookie, and reject requests
without the CSRF token except for `POST /api/login`.

| Method and path | Purpose |
| --- | --- |
| `POST /api/login` | Password to session cookie |
| `POST /api/logout` | Clear the session |
| `GET /api/state` | Bindings, online status, producer generation, capability flags |
| `GET /api/sessions?agent=&keyword=&limit=&cursor=` | Session tree or search |
| `GET /api/sessions/:id/messages?before=&limit=` | History page |
| `POST /api/sessions/:id/messages` | Send a message (streams over the socket) |
| `POST /api/sessions/:id/abort` | Stop the running turn |
| `POST /api/sessions` | Create a session |
| `GET /api/sessions/:id` | Session detail |
| `PATCH /api/sessions/:id` | Title or composer mode |
| `DELETE /api/sessions/:id` | Delete |
| `POST /api/sessions/:id/pin` | Pin or unpin |
| `POST /api/permissions/:requestId` | Approve or deny |
| `GET /api/projects`, `/api/models`, `/api/skills` | Producer catalogs |
| `GET|PUT /api/preferences/pinned` | Pinned order |
| `POST /api/attachments` | Upload (section 10) |

Browser socket messages:

```jsonc
// server → browser
{"kind":"evt","type":"session.message_chunk","payload":{...},"eventId":42}
{"kind":"evt","type":"permission.ask","payload":{...}}
{"kind":"state","binding":{"online":true}}
{"kind":"ack","requestId":"r-1","payload":{...}}
{"kind":"err","requestId":"r-1","code":"SESSION_BUSY","message":"..."}

// browser → server
{"kind":"cmd","requestId":"r-1","type":"session.send","payload":{...}}
{"kind":"permission","requestId":"r-2","decision":"allowOnce","requestIds":["p-1"]}
```

`requestId` is PRC-scoped and exists only to correlate a browser request with its
reply; it is unrelated to the protocol's `cmd.id`.

## 8. Command mapping

PRC mints `cmd.id`, sends the frame, and resolves the browser request when
`ack.*` or `err.*` with a matching `in_reply_to` arrives. A request times out
after 30 seconds; streaming commands resolve on the acknowledgement and continue
pushing `evt.*`.

| Browser action | `cmd.*` | Payload (snake_case, producer-read) | Acknowledgement |
| --- | --- | --- | --- |
| list sessions | `cmd.session.list` | `{agent?, keyword?, limit?, cursor?}` | projected list with `pinned` merged from the roster |
| history | `cmd.session.history` | `{session_id, before_msg_id?, limit?}` | `{messages_json, has_more, oldest_msg_id}` |
| send | `cmd.session.send` | `{session_id, content, model?, client_intent?, attachments?}` | `{disposition:"sent"}` then `evt.*`; `{disposition:"queued", item_id}` when busy |
| new | `cmd.session.new` | `{agent?, workspace?, title?, parent_session_id?, visibility?, purpose?}` | created session |
| resume | `cmd.session.resume` | `{session_id}` | ack then `evt.*` |
| stop | `cmd.session.stop` | `{session_id}` | ack plus a deterministic `turn_end{aborted}` |
| pin | `cmd.session.pin` | `{session_id, pinned}` | route body verbatim |
| approve | `cmd.permission.respond` | `{request_ids, decision:1\|2, remember?}` | `{processed, skipped}` |
| detail | `cmd.session.get` | `{id}` | session body verbatim |
| rename or mode | `cmd.session.update` | `{id, title?, interaction_mode?}` | update body, or an intent ack |
| delete | `cmd.session.delete` | `{id}` | delete body |
| projects | `cmd.projects.list` | `{}` | typed project list |
| workspaces | `cmd.workspace.list` | `{}` | flattened projection |
| pins | `cmd.pinned.list` | `{}` | ordered items |
| reorder | `cmd.pinned.reorder` | `{items:[{item_type,id}]}` | updated items |
| models | `cmd.model.list` | `{session_id?}` | `{...body, models}` |
| skills | `cmd.skill.list` | `{query?}` | skills body |

`interaction_mode` is `0` default, `1` plan, `2` goal. It is delivered to the
renderer as a composer intent and is never persisted by the producer, so the
console treats it as transient.

Any route added later can be reached through the generic form: a command carrying
`route: {method, path, kind}` is executed against the local runtime with the
desktop's structural guards only. PRC is the route gate in this deployment, so
its command allowlist must be explicit and versioned.

## 9. Events and permissions

| Frame | Payload | Console behaviour |
| --- | --- | --- |
| `evt.session.message_chunk` | `{session_id, chunk}` where `chunk` is the raw stream JSON | Append text; `RespData.type` 6 is a delta, 10 is a heartbeat and is ignored |
| `evt.session.message` | `{session_id, msg}` complete message, including the `role=user` echo | Reconcile the optimistic bubble |
| `evt.session.turn_end` | `{session_id, status, error_code?}` | Close the turn; `finished`, `aborted`, `error` |
| `evt.permission.ask` | `{session_id, request_id, tool_name, tool_input, rule_contents?, reason?, ts_ms}` | Render an approval card |
| `evt.permission.resolved` | `{session_id, request_id, decision}` | Close the card, including when resolved elsewhere |
| `evt.session.composer_mode_changed` | `{session_id, mode}` | Sync the mode indicator |
| any other `evt.<bus-type>` | snake_cased payload with `ts_ms` | Debug panel only |

Permission frames that belong to a remote-triggered turn carry `in_reply_to`;
frames without it are broadcasts and must reach every tab. `tool_input` is
redacted by the producer for logging only, not on the wire, so the console never
writes payloads to its own logs.

## 10. Attachments

### 10.1 Why the obvious path fails

The producer only accepts attachments it can download itself, and the downloader
is strict:

- the URL must be `https:` with no userinfo;
- the hostname must be in a hardcoded set: `matrix-internal-cn.oss-cn-shanghai.aliyuncs.com`,
  `matrix-internal.oss-us-east-1.aliyuncs.com`, plus the legacy
  `cdn.hailuoai.com` and `cdn.hailuoai.video`;
- redirects are rejected;
- caps are 20 MB per file, 50 MB per batch, 30 seconds per download.

Inline bytes do not bypass this. The router honours `local.data_url` only for
Goal objective resources; ordinary `attachments` always go through the
downloader, even on the generic route form.

### 10.2 Inbound: browser to producer

1. The console uploads with `POST /api/attachments` (multipart). PRC enforces
   20 MB per file and 50 MB per batch, sniffs the type, sanitises the filename,
   and stores the bytes under `data/attachments/<id>`.
2. PRC returns a signed, expiring URL:
   `https://<prc-host>/attachments/<id>?e=<expiry>&s=<hmac>`. The signature binds
   the attachment id, the binding id, and the expiry. Ten minutes, at most three
   fetches, then 404.
3. The console sends `cmd.session.send` with
   `attachments: [{url, mime_type, filename}]`.
4. The producer downloads, writes the bytes under its own
   `<userData>/remote-control/attachments`, and hands a `filePath` to the runtime,
   which persists them and exposes the image to the model.

Producer-side seam: the proxy accepts an injected `attachmentFetcher`, so PRC
mode supplies its own implementation of that interface instead of the vendor
factory. It keeps the same caps, the same `{ok, attachments[]}` success shape and
the same `{ok:false, failure:{code,message,retryable}}` failure shape, but its
host allowlist is the configured PRC origin. `https` stays mandatory; a plain
`http` origin is accepted only when the operator explicitly enables an insecure
LAN origin, and the setting is logged at startup.

Trade-off: reimplementing the fetcher duplicates roughly 120 lines of vendor
logic and must be kept in step with the bridge. Patching the vendored file
instead is smaller but is lost on the next client restore and is not acceptable
for a pinned snapshot.

### 10.3 Outbound: producer to browser

Files produced during a turn arrive in message content as media tags pointing at
paths on the producer. PRC fetches them through the runtime's remote-control file
route, which is bounded by `X-MCode-Remote-Control-File-Content-Max-Bytes`
(default 10 MiB, configurable), streams them to the browser, and never caches
them on disk. This leg already exists in the runtime; PRC only needs the generic
route plumbing and a same-origin content endpoint.

### 10.4 Rules

- Types: images (`png`, `jpeg`, `gif`, `webp`), `pdf`, and plain text. SVG is
  excluded because it is executable content in some viewers.
- Names: sanitised to a basename, 80 characters, no path separators.
- Retention: blobs are deleted one hour after upload or on `turn_end`, whichever
  comes first; the producer's copy is the durable one.
- Quota: the attachment directory is capped at 1 GB with oldest-first eviction.
- Audit: log the attachment id, byte count and mime type; never the signed URL or
  the content.

## 11. Storage

SQLite through `node:sqlite` (Node 22+), with no native dependency. Fallback for
environments without it: append-only JSON files, single process only.

| Table | Columns |
| --- | --- |
| `operator` | `id`, `password_hash`, `created_at` |
| `binding` | `id`, `device_id`, `producer_generation`, `bound_at_ms`, `last_seen_ms`, `state` |
| `ticket` | `hash`, `binding_id`, `issued_at_ms`, `expires_at_ms`, `consumed_at_ms` |
| `event_log` | `binding_id`, `event_id`, `ts_ms`, `type`, `payload_json` |
| `command_log` | `cmd_id`, `binding_id`, `consumer_id`, `type`, `state`, `reply_json`, `ts_ms` |
| `attachment` | `id`, `binding_id`, `filename`, `mime_type`, `bytes`, `sha256`, `created_at_ms` |
| `session_snapshot` | `session_id`, `title`, `status`, `updated_at_ms`, `json` |

Tickets are stored as hashes; the plaintext exists only in the HTTP response.
`event_log` is trimmed by count and age per binding. `command_log` is trimmed
after the dedupe window.

## 12. Security

- Password: `scrypt` with a per-install salt, stored as `scrypt$N$r$p$salt$hash`;
  comparison is constant time. Login is limited to five attempts per minute per
  address.
- Sessions: signed, `HttpOnly`, `SameSite=Lax`, `Secure` unless the operator
  declared a plaintext LAN origin. Seven-day expiry, rotating on login. CSRF is a
  double-submit token on every mutating route.
- Producer credentials: `X-PRC-Password`, rate limited per address. The password
  is never echoed in a response and never logged.
- Tickets: 60 seconds, single use, bound to one binding, consumed at socket auth.
- Socket: only authenticated sessions and ticket-bearing producers get a socket;
  unknown bindings are rejected before hello.
- Transport: production must be `https`/`wss` behind a reverse proxy. Plaintext is
  an explicit opt-in for a trusted LAN. While the opt-in is off, `POST
  /api/attachments` refuses to mint a URL for a plaintext origin, so the failure
  is visible at upload time rather than as a producer-side download error.
- Logging: passwords, tickets, signed attachment URLs, message bodies and tool
  inputs never reach a log file.

## 13. Desktop integration

Configuration, additive and optional:

```jsonc
{
  "remote_control": {
    "prc": {
      "url": "https://prc.example.com",
      "password": "…",
      "allow_insecure_origin": false
    }
  }
}
```

Behaviour:

1. When `remote_control.prc` is absent, the client behaves exactly as today.
2. When present, the main process becomes the credential source: it calls
   `GET {url}/minimax-cloud/api/v1/remote-control/desktop/bindings` with
   `X-Device-Id`, `X-Producer-Type: desktop` and `X-PRC-Password`, applies the
   result through the proxy's credential entry point, and connects. The renderer
   no longer signs binding reads, because it has no PRC credential.
3. Refresh replaces the renderer-refresh hook: on `need-credentials` the main
   process re-reads the binding itself and retries immediately instead of waiting
   out the backoff.
4. `bound_user_id` is written from the PRC operator id so account-switch cleanup
   cannot clear a PRC binding when the cloud identity changes.
5. Status keeps flowing through `rc:status-changed` with an added
   `source: "prc"` field; unknown fields are ignored by the existing renderer.
6. The attachment fetcher is replaced as described in section 10.2.
7. The proxy still dedupes by command scope, so a PRC reconnect must produce a new
   scope, which it does by construction.

## 14. Phases and acceptance

| Phase | Content | Acceptance |
| --- | --- | --- |
| M1 | Password login, binding and ticket, socket hello/auth/ping, event ids, `session.list`, `session.history`, `session.send`, `session.stop`, browser socket, minimal session view | A bridge-based producer double completes a turn end to end; text streams into the browser |
| M2 | Remaining commands, permission frames and replies, replay, busy and queue dispositions | Conformance script covers all 17 commands plus replay and dedupe |
| M3 | Attachments in and out, stream reconciliation, multi-tab, offline and reconnect states | Browser end-to-end test covers send, stop, approve, reconnect, image round trip |
| M4 | Packaging: single command start, Dockerfile, reverse proxy sample, health endpoint, operator guide, source inventory registration | Fresh machine: start, configure, connect, one turn |

## 15. Testing

- **Protocol conformance**: run the real `@mavis/remote-control-bridge` against
  PRC in a Node harness. Cover hello, auth, ping/pong, ticket replay, malformed
  frames, oversized frames, `superseded`, replay window and overflow.
- **Command router**: unit tests with a fake socket for ack, err, timeout,
  cancellation and duplicate `cmd.id`.
- **Attachments**: signed URL expiry, tampered signature, oversize, disallowed
  type, missing host in the producer allowlist.
- **Browser**: Playwright against a stubbed producer for send, stop, permission,
  reconnect, and image attachment.
- **Security**: wrong password, replayed ticket, unauthenticated socket, CSRF
  missing, path traversal in filename.

## 16. Risks

1. **Vendor drift.** The injected fetcher and the command payloads mirror the
   vendored bridge. Every client restore must re-run the conformance suite; a new
   command or a changed field appears first as a failing test, not as a silent
   no-op.
2. **Unverified producer identity.** PRC issues its own operator identity while
   the desktop may still hold a cloud identity. The two must not fight over
   `bound_user_id`; section 13.4 is the mitigation and needs a regression test.
3. **Attachment duplication.** Reimplementing the downloader duplicates vendor
   behaviour. The alternative, editing the pinned snapshot, is worse; the
   mitigation is a shared test vector for caps, scheme and redirect handling.
4. **LAN plaintext.** Allowing `http` for attachments weakens transport security.
   It stays opt-in and is reported by the health endpoint.
