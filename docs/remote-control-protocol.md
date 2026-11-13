# Remote control: protocol and control paths

A MiniMax Code desktop install runs one agent runtime and exposes it to four
control surfaces. They differ in who starts the conversation, how a request
reaches the runtime, and how events travel back:

| Surface | Who acts | Path into the runtime |
| --- | --- | --- |
| Desktop app UI | the signed-in user at this machine | preload IPC + MessagePort to the utility process |
| Remote Control (RC) | a paired consumer device (phone, tablet, another machine on the same account) | WebSocket frames relayed by the cloud gateway |
| IM channels | Feishu, Telegram and WeChat chats | platform SDK or webhook into the channel bridge |
| SSH project | a project host added over SSH | main-process broker to the connected host |

All four end up driving the same local runtime HTTP surface
(`/mavis/api/...` and the generated `/minimax-desktop/api/v1/...` routes). What
changes is the delivery semantics: RC speaks a typed frame protocol, IM speaks
chat messages with interactive cards, the app speaks request/response plus
streaming over a message port, and SSH forwards a small fixed request set.

The RC consumer leg (mobile client and cloud gateway) is not part of this
repository. This document fixes the contract that leg must honour: the pairing
HTTP API, the WebSocket envelope, the command set, and the event stream.

## Remote Control

### Roles and identity

- **Producer** — this desktop. Holds the binding, owns the WebSocket, executes
  commands and emits events. It identifies itself as `X-Producer-Type: desktop`.
- **Consumer** — a paired device. Sends HTTP requests to the cloud, receives
  translated `cmd.*` frames from the gateway and `evt.*` frames back.
- **Gateway** — cloud side. Authenticates the consumer, maps its HTTP requests
  onto command frames, buffers and replays events, and is the authoritative
  route gate for commands.

One producer can serve several consumers; binding status reports
`consumer_count` and `online_consumer_count`.

Two protocol constants live in `apps/electron/vendor/@mavis/remote-control-bridge`:

- `RC_API_BASE_PATH = "/minimax-cloud/api/v1/remote-control"`
- `RC_MULTI_DEVICE_PROTOCOL_VERSION = 3`, sent as `rc_protocol_version` on the
  binding read and in the pairing request body.

### Pairing and binding

The binding is a server-side relation between a user and one desktop device. It
is created with a short code and then kept alive by a one-shot ticket.

| Endpoint | Purpose |
| --- | --- |
| `POST /pairing/code` | issue a 4-digit pairing code; `expires_in_s` defaults to 300 |
| `GET /desktop/bindings` | read binding state; when bound, the response carries a freshly signed 60-second one-shot ticket |
| `POST /unbind` | remove the binding |

Pairing request body: `{platform, rc_protocol_version, app_version, device_name}`.
Binding response: `state` (`none` | `bound`), `ticket`, `endpoint`,
`binding_id`, `bound_at_ms`, `expires_at_ms`, `producer_generation`,
`consumer_count`, `online_consumer_count`, `producer_version`.

Every request carries `token: <user JWT>`, `Authorization: Bearer <user JWT>`
(forward compatibility only), `X-Device-Id` and `X-Producer-Type: desktop`.
`user_id` travels as a query parameter and must equal the token's subject.

Pairing sequence (`RcPairingSession` in `pairing-session.js`):

1. `POST /pairing/code`, publish `phase: pairing` with the code and TTL.
2. Poll `GET /desktop/bindings` once per second.
3. On `state: bound` write the binding locally, then connect.
4. If the code expires, re-issue it no more than once every 5 seconds.
5. Give up after 30 consecutive poll failures, or immediately on
   `token_expired` / `not_authenticated`.

Unbinding is idempotent across restarts: `beginProducerUnbind()` mints a
`request_id`, persists it in the local RC state file, and only accepts the two
definite outcomes `confirmed` and `rejected`. Timeouts and network errors must
stay pending — a timed-out HTTP call is not proof that the server kept the
binding.

### Local state

`DeviceIdentityStore` owns `<userData>/remote-control/state.json`:

- `desktop_device_id` — UUID v4, created once per install and reused forever,
  surviving unbinds.
- `binding_id`, `bound_user_id`, `producer_generation` — written when pairing
  completes, cleared on unbind.
- `pending_unbind_request_id` — the idempotency record above.

The file never stores tickets or JWTs, and writes are atomic (temporary file
plus rename) so a crash cannot leave a half-written state.

### Connection lifecycle

```
wss://<endpoint>?binding_id=<id>&ticket=<t>&client_version=<v>&last_event_id=<seq>
```

- The URL never contains the raw device id; `endpoint`, `ticket` and
  `binding_id` come from the binding read, not from configuration.
- Handshake: the gateway sends `ctrl.hello {connection_id, server_time_ms,
  max_message_bytes}`; the client answers `ctrl.auth.complete
  {last_event_id?}`. `client_version` travels on the URL only.
- Heartbeat: `ctrl.ping` every 5 seconds. Fifteen seconds without any inbound
  frame is treated as a dead connection.
- Reconnect: exponential backoff 1, 2, 4, 8, 16, 30 seconds. Every attempt
  re-reads a fresh one-shot ticket, and the new handshake carries
  `last_event_id` so the gateway can replay what was missed.
- Health: the client polls runtime readiness while connected. If the runtime
  goes away it sends `ctrl.disconnect_reason {code: "daemon_unavailable"}`,
  closes, and reconnects once readiness returns.
- Frame size: the desktop floor and default is 128 MiB. `ctrl.hello` may raise
  the cap for a connection but cannot lower it below that floor.

Disconnect codes decide the next step:

| Code | Meaning | Behaviour |
| --- | --- | --- |
| `superseded` | another connection took over the same binding | stop quietly |
| `auth_expired`, `ticket_invalid` | credentials rejected | stop; the owner re-signs and decides |
| `server_initiated_unbind` | the server removed the binding | stop and clear the binding |
| `app_quit` | local shutdown | stop, keep the binding |
| `daemon_unavailable` | runtime unhealthy (sent by the client) | reconnect after recovery |
| `server_shutdown`, abnormal close | gateway or network drop | backoff reconnect |

### Envelope and frame families

Every frame is one JSON object (`frame-codec.js`):

```json
{
  "v": 1,
  "id": "f-<uuid>",
  "ts": 1789000000000,
  "type": "cmd.session.send",
  "payload": {},
  "source": "desktop",
  "in_reply_to": "f-<uuid of the command>",
  "trace_id": "...",
  "event_id": 42
}
```

`v`, `id`, `type` and `ts` are required; `payload` must be an object when
present; `event_id` is assigned by the gateway and is the replay cursor;
`in_reply_to` links a reply or a permission event to its command.

| Family | Direction | Purpose |
| --- | --- | --- |
| `ctrl.*` | both | connection control: hello, auth, ping/pong, disconnect reason, replay overflow |
| `cmd.*` | consumer → desktop | a command (`cmd.<domain>.<action>`) |
| `ack.*` / `err.*` | desktop → consumer | the outcome of one command |
| `evt.*` | desktop → consumer | stream chunks, turn ends, permission asks, bus events |

`err.<domain>.<action>` always carries `{code, message, retryable}` and
`in_reply_to` set to the command id.

### Command surface

Each command maps onto one local runtime route, invoked in-process with
`X-MCode-Request-Source: remote-control`; the bridge never mints its own
credentials and inherits the desktop login.

| Command | Route |
| --- | --- |
| `cmd.session.list` | `GET /agent/:name/session/tree` (keyword search uses `/session/search`), plus the pinned roster |
| `cmd.session.history` | `GET /session/:id/message` |
| `cmd.session.send` | `POST /session/:id/message` (SSE); a busy session falls back to `/session/:id/queue` |
| `cmd.session.new` | `POST /agent/:name/session` |
| `cmd.session.resume` | `POST /session/:id/resume` (SSE) |
| `cmd.session.stop` | `POST /session/:id/abort` |
| `cmd.session.get` | `GET /session/:id` |
| `cmd.session.update` | `PATCH /session/:id` (title; `interaction_mode` is delivered to the renderer as a composer intent, never persisted) |
| `cmd.session.delete` | `DELETE /session/:id` |
| `cmd.session.pin` | `POST /pin/session` |
| `cmd.permission.respond` | `POST /permission/batch-reply` |
| `cmd.workspace.list` | `GET /projects` (legacy flattened projection) |
| `cmd.projects.list` | `GET /projects` (typed structure with embedded session tree) |
| `cmd.pinned.list` | `GET /preferences/pinned-items-order` |
| `cmd.pinned.reorder` | `PUT /preferences/pinned-items-order` |
| `cmd.model.list` | `GET /models/list` |
| `cmd.skill.list` | `GET /skills` |

Two details are deliberate and easy to break:

- `cmd.session.list` and `cmd.session.history` are projected into the frozen
  acknowledgement shapes the gateway parses. Passing the web response through
  verbatim yields empty sidebars and empty history on the consumer.
- A command may instead carry `route: {method, path, kind}` for routes added
  after this list. The desktop only enforces structural guards (no `..`, no
  absolute or protocol-relative URL, no origin change). There is no compiled-in
  allowlist: the gateway's own route configuration is the authoritative gate,
  so adding a route there is what makes it reachable.

`cmd.session.send` carries `content`, optional `model`, optional
`client_intent` (`plan-entry`, `plan-exit`, `retry-continuation`), optional
`attachments: [{url, mime_type, filename}]`, and optional
`retry_message_id` / `discard_message_id` for undelivered side messages. A
successful send acknowledges `{disposition: "sent"}` and then streams; a busy
session acknowledges `{disposition: "queued", item_id}`.

### Event upstream

Streaming commands acknowledge first and pump afterwards. The pump maps server
sent events onto frames:

| Source | Frame |
| --- | --- |
| agent message chunk (RespData 6) | `evt.session.message_chunk` |
| complete agent message (RespData 2) | `evt.session.message` |
| heartbeat (RespData 10) | dropped — the gateway emits its own |
| stream error | `err.<domain>.<action>`, then stop |
| end of stream | `evt.session.turn_end` with the session terminal (`finished`, `aborted`, `error`) |

Chunk payloads embed the raw streamed JSON byte for byte; the envelope is built
by string templating so a re-serialisation cannot reorder fields or change
number formatting.

Global runtime events are forwarded one to one: the frame type is the event
type with an `evt.` prefix and the dots preserved (`session.start` becomes
`evt.session.start`), the payload is shallow snake-cased and gains `ts_ms`.
Events with a dedicated mapper get a pruned payload; everything else falls back
to the generic shape.

Permission traffic has its own frames, and the type strings are contractual:
the gateway strips the `evt.` prefix on the consumer outlet, so a phone sees
bare `permission.ask` / `permission.resolved` and matches them exactly.

```json
// evt.permission.ask
{"session_id":"...","request_id":"...","tool_name":"...","tool_input":"...",
 "rule_contents":"...","tool_description":"...","reason":"...","ts_ms":0}

// evt.permission.resolved
{"session_id":"...","request_id":"...","decision":"allowOnce|allowAlways|deny"}
```

A permission ask born from a remote command carries `in_reply_to` set to that
command id; a locally initiated turn emits it as a broadcast without
`in_reply_to`.

### Reliability rules

- **Command dedupe** — a five-minute LRU keyed by `(commandScope, cmd.id)`,
  capped at 512 entries. A duplicate that already finished replays the cached
  acknowledgement or error; a duplicate still in flight is dropped. This is what
  prevents double sends and double session creation after a reconnect.
- **Command scope** — `commandScope` is the JSON form of
  `[identity, request_epoch]`, where identity is
  `{user_id, producer_type, producer_device_id, producer_generation}`. Credential
  refreshes bump `request_epoch`, so a frame queued under an old epoch cannot
  execute against the new connection.
- **Replay** — `event_id` is monotonic and assigned by the gateway. A client
  that reconnects with `last_event_id` asks for the gap to be replayed; a
  `ctrl.replay.overflow` frame means the window is lost and state must be
  refetched wholesale.
- **Abort cascade** — `cmd.session.stop` cancels the stream reader and emits a
  deterministic `evt.session.turn_end {status: "aborted"}`. A socket drop
  cancels every in-flight pump without emitting anything; this protocol does
  not buffer turns while offline.
- **Oversized frames** — a frame above `max_message_bytes` is dropped, audit
  logged, and reported once per stream as `FRAME_TOO_LARGE`; pumping continues.
- **Attachments** — URLs are downloaded before the runtime sees them, landing
  under `<userData>/remote-control/attachments` and reaching the runtime as a
  `filePath`. Limits: 20 MB per file, 50 MB per batch, 30 seconds per download,
  allowlisted storage hosts only, redirects never followed. Any failure fails
  the whole send; there are no partial sends.
- **Log hygiene** — tickets, JWTs and presigned URLs never reach the log; the
  WebSocket URL is redacted before it is logged, and remote-control traffic has
  its own log category.

### Failure vocabulary

| Area | Codes |
| --- | --- |
| Request shape | `INVALID_ARGUMENT`, `UNSUPPORTED_COMMAND`, `ROUTE_NOT_ALLOWED` |
| Session state | `SESSION_BUSY`, `PERMISSION_DENIED`, `COMMAND_CANCELLED` |
| Runtime | `DAEMON_UNAVAILABLE` (retryable), `INTERNAL_ERROR`, `RATE_LIMITED` (retryable) |
| Attachments | `ATTACHMENT_UNSUPPORTED`, `ATTACHMENT_TOO_LARGE`, `ATTACHMENT_MIME_REJECTED`, `ATTACHMENT_FETCH_FAILED` (retryable) |
| Model / composer | `MODEL_SELECTION_UNAVAILABLE`, `MODEL_SELECTION_REJECTED`, `COMPOSER_SYNC_UNAVAILABLE` |
| Transport | `FRAME_TOO_LARGE`, `NOT_IMPLEMENTED` |

### Desktop integration

`apps/electron/main/modules/remote-control-bridge/ipc.ts` wires the proxy into
the app:

- `rc:connect`, `rc:disconnect`, `rc:get-status`, `rc:get-device-id`,
  `rc:get-device-name`, `rc:request-code`, `rc:binding-ready`,
  `rc:binding-lost`, `rc:mark-unbound`, `rc:begin-unbind`,
  `rc:get-pending-unbind`, `rc:resolve-unbind`,
  `rc:publish-session-composer-mode`; status and composer changes push back as
  `rc:status-changed` and `rc:session-composer-mode-changed`.
- Main cannot sign `GET /desktop/bindings`, because that signature belongs to
  the renderer's HTTP pipeline. When credentials go stale the proxy broadcasts
  `rc:refresh-binding`, the renderer re-signs and pushes the result back through
  `rc:binding-ready`; a stale `request_epoch` is rejected rather than applied.
- Account switching is deliberately asymmetric: if `bound_user_id` no longer
  matches the signed-in user, the desktop disconnects and clears the local
  binding but does **not** call `/unbind`. The current token belongs to the new
  account, and using it to delete the previous account's binding would be
  impersonation.
- Quit sends `ctrl.disconnect_reason {code: "app_quit"}` and keeps the binding.
- Keep-awake is enabled only while a binding exists and the phase is not
  `unbound`.

## The desktop app path

The renderer does not talk to the runtime over a loopback socket. Two transports
serve it, both gated to the same path prefixes (`/mavis/`,
`/minimax-desktop/api/`, and the `/archon/api/v1/` alias rewritten to
`/mavis/api/`):

- **MessagePort** (`packages/local-runtime/src/transport/runtime-transport-host.ts`)
  — client frames `request`, `stream-credit` and `abort`; server frames
  `response-start`, `stream-chunk`, `stream-done` and `stream-error`, each
  carrying a per-request sequence number. Response chunks are coalesced by time
  and byte budget, and clients advertise a window they replenish as they drain.
- **`app://` handler** (`apps/electron/main/modules/protocol/index.ts`) — the
  same admission rules for traffic that does not use the port.

Main-process consumers, including the RC bridge, call
`fetchViaUtilityRuntime(request, transportConsumer)` and receive a sibling port
per consumer. That isolation is deliberate: a long-lived stream on one port must
not delay remote-control commands on another.

## The IM path

### Inbound transports

| Platform | Inbound |
| --- | --- |
| Feishu | SDK long connection subscribed to `im.message.receive_v1`, or `POST /mavis/api/channel-bridge/feishu/webhook`; card actions arrive on `/feishu/card-action` |
| Telegram | `getUpdates` long poll with `timeout=25`, or `POST /mavis/api/channel-bridge/telegram/webhook`; bind and unbind on `/telegram/bind` and `/telegram/unbind` |
| WeChat | iLink bot monitor, or `POST /mavis/api/channel-bridge/wechat/webhook`; bind status on `/wechat/bind/status` |

The WeChat wire drops three classes before dispatch: messages whose
`message_type` is not `USER`, messages older than ten minutes, and anything the
bot itself sent. The last rule prevents an outbound echo from becoming an
inbound turn.

### Connections, bindings and routes

- `LocalImConnection` — one bot connection: credentials, channel, agent and
  project. WeChat onboarding uses the iLink QR flow; Feishu onboarding collects
  app credentials.
- `LocalImPhysicalBinding` — one chat (`platform + clientName + chatId`, plus
  thread and lane) bound to a session.
- Route rules — `channel-routes.yaml`, matched by platform and
  `{chatType, chatId, senderId, clientName}`, first match wins by `priority`,
  with an optional `requireMention`.
- Session strategies — `per-sender`, `per-chat`, `shared-task`, and `root`. The
  current routing model maps root-shaped intent to `project-main`: the most
  recent visible top-level conversation inside one project. The legacy `main`
  and `pin` values are read-only compatibility.

### Admission

Access control is per connection: `allowedUsers` and `allowedGroups` (either a
list or `ALL`), `groupMentionPolicy` (`mentionOnly`, `always`, `disabled`),
`respondToMentionAll`, and an owner gate. WeChat is p2p-only, so its owner gate
is redundant and skipped. Denials reply privately with a readable reason
(`group_chat_disabled`, `group_not_allowed`, `mention_required`,
`user_not_allowed`, `owner_only`) instead of failing silently.

Replays are dropped by a five-minute dedupe cache keyed
`${platform}:${clientName}:${eventId}`, so a webhook retry cannot start a second
turn.

### One message, end to end

1. The adapter normalises the platform event into a channel envelope
   (attachments stay as platform resource keys until resolved).
2. Preflight decides allow, deny or dedupe.
3. A permission reply is intercepted first, then a questionnaire reply — both
   ride platform callback events, and only the pending tables plus the encoded
   payload distinguish them.
4. The route resolver picks the agent and session strategy, then creates or
   reuses the session.
5. The message is enqueued as a session-queue item with a `channel:` source.
   A busy session answers "queued, N ahead" rather than failing.
6. The channel drain runs one turn at a time, in order, and re-drains after the
   turn's terminal event.
7. The reply is collected from the stream (or from committed messages) and
   delivered to the chat.

### Control surface

| Capability | Feishu | Telegram | WeChat |
| --- | --- | --- | --- |
| Session commands | `/new`, `/clear`, `/stop`, `/compact` | same | same (plain text) |
| Permission approval | card buttons | inline keyboard | three slash commands (no buttons) |
| `ask_user` | structured card | inline keyboard | numbered text |
| Inbound attachments | `file_key` / `image_key` download | `file_id` download | CDN key download |
| Progress | thinking placeholder card patched into the final reply | typing indicator | — |

The slash-command allowlist is a single source of truth
(`LOCAL_CHANNEL_SLASH_COMMANDS` in `channel-inbound-utils.ts`); the parser, the
TypeScript union and the dispatch registry all derive from it, so a command
cannot exist in one place and be missing in another. `/btw` and `/pin` are
deliberately not listed.

Permission cards are routed strictly by origin: a card is rendered only to the
binding that matches the originating turn (`platform + clientName + chatId`).
Turns started on the desktop itself render to no IM binding at all.

### Outbound

- Message filtering is per binding: `mode: result` sends the final answer only,
  `mode: full` also appends a tool-call summary (`includeToolSummary`).
- Media is modelled with the same value object the UI uses for deliverables, so
  a file is either a real attachment for both surfaces or for neither.
- Failures are sanitised before they reach a chat. The internal message, partial
  output and upstream detail are dropped and replaced with a fixed line, so a
  failed turn cannot leak half a response.

## Comparison

| Aspect | Remote Control | Desktop app | IM |
| --- | --- | --- | --- |
| Transport | WebSocket frames through the gateway | MessagePort / `app://` | platform SDK, webhook or long poll |
| Authentication | one-shot ticket plus producer identity | local session, inherited auth context | bot credentials plus access control |
| Command granularity | 17 typed commands plus generic routes | full HTTP surface | natural language plus 4 slash commands |
| Event delivery | ack, then streamed `evt.*` with replay cursor | streamed over the port with flow control | collected, then delivered as chat output |
| Idempotency | `(commandScope, cmd.id)` for 5 minutes | not applicable | `platform:client:eventId` for 5 minutes |
| Offline behaviour | no buffering; reconnect and replay | request fails | next poll resumes from the cursor |

## Where to look

| Concern | File |
| --- | --- |
| Frame types, envelope, size caps | `apps/electron/vendor/@mavis/remote-control-bridge/dist/frame-codec.js` |
| Pairing and binding HTTP | `.../dist/pairing-client.js`, `.../dist/pairing-session.js` |
| WebSocket lifecycle | `.../dist/connection.js` |
| Command routing | `.../dist/command-router.js` |
| Stream pump and event mapper | `.../dist/stream-pump.js`, `.../dist/event-frame-mapper.js`, `.../dist/permission-upstream.js` |
| Attachment download | `.../dist/attachment-fetch.js` |
| Proxy state machine | `.../dist/index.js`, `.../dist/data-plane.js` |
| Electron wiring and IPC | `apps/electron/main/modules/remote-control-bridge/` |
| Runtime transport | `packages/local-runtime/src/transport/` |
| Channel bridge routes | `packages/local-runtime/src/channels/infra.ts` |
| Channel runner | `packages/local-runtime/src/channels/runner.ts` |
| Access control | `packages/local-runtime/src/channels/access-control-policy.ts` |
| Route model | `packages/shared/src/channel-route.ts` |
| Remote session broker | `apps/electron/main/modules/local-runtime/utility/remote-session-broker.ts` |
