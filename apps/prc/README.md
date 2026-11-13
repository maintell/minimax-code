# PRC (`@mavis/prc`): operator guide

PRC is a self-hosted gateway that lets one operator drive one MiniMax Code
desktop client from a browser. The desktop keeps its runtime and its tools; it
opens an outbound WebSocket to the gateway, so the operator's machine needs no
inbound port.

`apps/prc` is deliberately outside the repository workspace: it has its own
lockfile and a single runtime dependency (`ws`), and it is installed on its own.

M1 ships password login, the binding and ticket handshake, the session
read/send/stop surface, and a minimal browser console. Two limits matter when
reading the [design][design]:

- Attachments are not implemented. There is no upload route, no signed URL
  endpoint and no injected fetcher yet; those are M3 ([design][design] §10.2).
- Stopping a turn has no HTTP route. The console sends `cmd.session.stop` over
  the browser socket ([design][design] §8), and `POST /api/sessions/:id/abort`
  does not exist.

[design]: ../../docs/superpowers/specs/2026-11-13-prc-design.md

## Requirements

- Node.js 24 or newer (`engines`). The server runs TypeScript directly and uses
  `node:sqlite`, so there is no build step and no native dependency.
- One operator password. Every browser that signs in is that same operator;
  there are no per-user accounts and no account switching.
- The HTTP listener is fixed to `127.0.0.1`. To reach the gateway from another
  machine, run a TLS-terminating reverse proxy on the same host.

## Install

```sh
cd apps/prc
pnpm install --ignore-workspace
```

`--ignore-workspace` installs PRC on its own. The directory is not a member of
the repository workspace (`pnpm-workspace.yaml` does not list it), so the flag
keeps its dependency graph and lockfile separate from the monorepo.

## First run

The first start stores the operator password. Pass it once through the
environment:

```sh
cd apps/prc
PRC_PASSWORD='<operator passphrase>' node src/main.ts
```

On Windows PowerShell:

```powershell
cd apps/prc
$env:PRC_PASSWORD = '<operator passphrase>'; node src/main.ts
```

The first start writes `data/operator.json` (mode `0600`), generates
`data/session-secret`, creates the database, and logs:

```text
operator password is now stored hashed in .../data/operator.json
PRC listening on http://127.0.0.1:8787 (public http://127.0.0.1:8787)
```

After that, restart with no password at all:

```sh
node src/main.ts
```

`PRC_PASSWORD` is read only while `operator.json` does not exist, so leaving it
set later changes nothing. `--password <value>` is the alternative for the first
start and takes precedence over the variable; prefer the variable, which stays
out of the process title. `pnpm start` runs the same command as `node
src/main.ts`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PRC_PORT` | `8787` | Loopback port to listen on. |
| `PRC_DATA_DIR` | `apps/prc/data` | Directory for the password hash, the cookie secret and the database. Resolved to an absolute path. |
| `PRC_PUBLIC_URL` | `http://127.0.0.1:<PRC_PORT>` | The origin browsers and producers use. Not a bind address. |
| `PRC_TRUST_PROXY` | unset | `1` or `true` makes the rate limiters read the rightmost `X-Forwarded-For` hop. |
| `PRC_PASSWORD` | unset | Bootstrap only: read when `operator.json` is absent. |

### What `PRC_PUBLIC_URL` must be

It is the address the operator publishes, and three things are derived from it,
so it must match what clients actually use:

- **Cookies.** When it starts with `https:`, the session cookies carry `Secure`.
  An `https:` value served over plaintext HTTP therefore leaves the browser
  unable to store the cookie, and no session survives.
- **The producer endpoint.** The desktop is handed
  `wss://<host>/rc` for an `https:` origin and `ws://<host>/rc` otherwise
  (`src/http.ts`, `producerEndpoint`). If TLS ends at a proxy but this variable
  still says `http:`, the desktop is told to open a plaintext socket to the
  public host and cannot connect.
- **Attachment URLs (M3, not implemented).** When that leg lands, signed URLs
  will be minted from this origin and a plaintext origin will be refused unless
  the operator opts in. Nothing in M1 serves or mints them.

Trailing slashes are trimmed. PRC always serves at the **root** of its origin:
the console requests `/api/...`, the browser socket is `/ws`, and the producer
endpoint is `/rc` on the same host. A reverse-proxy path prefix such as
`https://example.com/prc` will not work.

## Reverse proxy

PRC listens on loopback only, so the proxy and the gateway run on the same host.
The proxy terminates TLS, forwards the whole origin, and passes WebSocket
upgrades through for both `/rc` (producers) and `/ws` (browsers). An nginx
example:

```nginx
server {
    listen 443 ssl;
    server_name prc.example.com;

    # A large paste is posted as an HTTP body; message frames are capped at 128 MiB.
    client_max_body_size 128m;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;

        # Without these two headers both sockets fail to upgrade.
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # The producer keeps the connection alive with ctrl.ping, which the
        # gateway answers with ctrl.pong; keep the proxy's idle timeout well
        # above the client's ping interval.
        proxy_read_timeout 120s;
    }
}
```

Set `PRC_PUBLIC_URL=https://prc.example.com` to match. Set
`PRC_TRUST_PROXY=1` only behind a proxy you control: it makes the login and
producer budget key on the rightmost `X-Forwarded-For` hop, which is the address
your proxy observed. Without it, every client looks like `127.0.0.1` and all of
them share one budget of five logins per minute, so one wrong password locks
every browser out for a minute.

## Health check

```sh
curl -fsS https://prc.example.com/healthz
# {"ok":true}
```

The route answers before authentication and reveals nothing, which also means
it is a liveness probe and nothing more: it does not report whether a producer
is bound or whether the database is writable. Keep it reachable only through the
proxy.

## Sign in from a terminal

The console is a static page at `/`; the API is usable directly. The examples
are POSIX shell: on Windows PowerShell call `curl.exe` and re-quote the JSON
bodies for it, because the shell strips single quotes differently.

```sh
# 1. Exchange the operator password for a session cookie and a CSRF token.
curl -sS -c prc-cookies.txt -H 'content-type: application/json' \
  -d '{"password":"<operator passphrase>"}' \
  https://prc.example.com/api/login
# => {"ok":true,"csrf":"<csrf token>"}

# 2. Ask which binding this installation serves. With no device header and a
#    single binding, that binding is the answer.
curl -sS -b prc-cookies.txt https://prc.example.com/api/state
# => {"binding":{"id":1,"deviceId":"<device id>","generation":1}}

# 3. List the producer's sessions. Every route below `/api` needs the session
#    cookie, and the device header once more than one binding exists.
curl -sS -b prc-cookies.txt -H 'X-Device-Id: <device id>' \
  https://prc.example.com/api/sessions

# 4. Send a turn. Mutating requests repeat the CSRF token from step 1 in a
#    header, and the cookie is sent automatically.
curl -sS -b prc-cookies.txt -H 'content-type: application/json' \
  -H 'X-CSRF-Token: <csrf token>' -H 'X-Device-Id: <device id>' \
  -d '{"content":"hello"}' \
  https://prc.example.com/api/sessions/<session id>/messages
```

Replies are the routed command result: `{"kind":"ack","payload":{...}}` or
`{"kind":"err","code":"...","message":"...","retryable":true}`. Streaming does
not arrive on these responses; it arrives on the browser socket. To stop a
running turn, open `/ws?binding_id=<id>` with the session cookie and send:

```json
{"kind":"cmd","requestId":"r-1","type":"cmd.session.stop","payload":{"session_id":"<session id>"}}
```

`cmd.session.stop` is the only stop path in M1, and an unknown or unsupported
command is answered with `UNSUPPORTED_COMMAND` rather than forwarded.

## Connect a desktop client

PRC mode is additive: with no `remote_control_prc` block the client behaves
exactly as before.

1. Start the gateway:

   ```sh
   cd apps/prc
   PRC_PASSWORD='dev-only-passphrase' node src/main.ts
   # PRC listening on http://127.0.0.1:8787 (public http://127.0.0.1:8787)
   ```

2. With the client **closed**, add the block to its config store. The store is
   `<userData>/minimax-agent-cn-config.json` on a Chinese production build
   (the international build uses `minimax-agent-config.json`), and the block goes
   inside its top-level `config` object:

   ```jsonc
   {
     "config": {
       "remote_control_prc": {
         "url": "http://127.0.0.1:8787",
         "password": "dev-only-passphrase",
         "allowInsecureOrigin": true
       }
     }
   }
   ```

   `allowInsecureOrigin` exists only to permit a plaintext `http:` origin during
   local work. Leave it out for a real deployment: with it absent, an `http:`
   URL makes the client log
   `PRC disabled reason=insecure_origin scheme=http` and stay on its normal cloud
   path, which is the intended failure.

3. `MC_RC_PRC_URL` and `MC_RC_PRC_PASSWORD` override the URL and password when
   both are set. They do not override `allowInsecureOrigin`, which stays a
   decision made in the file.

4. Launch the client. The remote-control log shows the phases of its own
   binding fetch, and on success:

   ```text
   [rc.ipc] prc connect start
   [rc.ipc] prc connect settled phase=connected binding_id=1
   ```

   Failures are reported as `[rc.ipc] prc connect failed reason=...` with
   `not_authenticated`, `not_bound`, `network:<name>` or `http_<status>`.

5. Open the console and sign in with the same password. The session list comes
   from the bound producer; the stop button and the composer are disabled while
   no binding exists.

In PRC mode the client owns the binding: a renderer "unbind" is logged as
`unbind skipped source=prc` and degrades to a plain disconnect, because a PRC
binding id must never reach the cloud pairing client. Remove a producer at the
gateway instead (see below).

## Data directory

| Path | Content |
| --- | --- |
| `operator.json` | The scrypt password hash, written on first run with mode `0600`. While it exists, `PRC_PASSWORD` is ignored. |
| `session-secret` | HMAC key for browser session cookies. Deleting it signs every browser out; producers are unaffected. |
| `prc.sqlite` | Bindings, one-shot tickets, and a rolling replay log trimmed to roughly the newest 2,000 frames per binding. |
| `prc.sqlite-wal`, `prc.sqlite-shm` | SQLite write-ahead sidecars, present while the process runs. |

`data/` is covered by `apps/prc/.gitignore`; it never enters version control.
Nothing else on disk holds state: the console keeps only its CSRF token in
`sessionStorage`.

## Backup and restore

A backup is one SQLite file: `prc.sqlite` holds the bindings, the one-shot
tickets and the replay log, and no other file grows with use. Two small files sit
beside it: `operator.json` and `session-secret`.

Stop the process, then copy the data directory. To copy a running process, take
`prc.sqlite` together with its `-wal` and `-shm` sidecars; a lone `prc.sqlite`
taken while PRC runs can lose the newest writes.

Restore is the reverse: put the files back and start PRC. Bindings, the event
cursor and the password survive. Browser sessions survive only when
`session-secret` is the same file, so back it up with the database.

## Upgrading

Replace the sources, run `pnpm install --ignore-workspace` again, and restart.
Bindings and the replay log live in the database, so producers reconnect on their
own and keep their binding id and replay window. Browsers may need a reload if
the process restarts long enough to drop the socket.

## Changing the operator password (a one-way door)

A restart with a different `PRC_PASSWORD` does nothing: the stored hash in
`operator.json` wins. To change the password:

```sh
# Stop PRC first.
mv data/operator.json data/operator.json.old
PRC_PASSWORD='<new passphrase>' node src/main.ts
```

This does **not** unbind producers. Bindings live in `prc.sqlite` and the
desktop keeps its device identity, so after the change it re-reads the same
binding with the new password and returns with the same binding id and replay
history. Rotating the password is not revocation, and there is no "log out all
producers" switch.

Update the client's `remote_control_prc.password` (`MC_RC_PRC_PASSWORD` when the
override is in use) in the same change, or its next binding fetch fails
`not_authenticated`. Ten failed fetches in a minute from one address make the
gateway answer `429` instead, so fix the client rather than retrying by hand.

To actually remove a producer, delete its binding. The route proves the operator
password in a header, the way the desktop does:

```sh
curl -sS -H 'content-type: application/json' \
  -H 'X-PRC-Password: <operator passphrase>' \
  -d '{"binding_id":1}' \
  https://prc.example.com/minimax-cloud/api/v1/remote-control/unbind
# {"ok":true}
```

That deletes the binding, its tickets and its replay log, and closes a live
socket with `ctrl.disconnect_reason` `server_initiated_unbind`, which is what
makes the desktop clear its local binding.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `{"error":{"code":"not_authenticated"}}` from `/api/login` | Wrong password. |
| `{"error":{"code":"RATE_LIMITED"}}` from `/api/login` | More than five attempts in a minute from one address. Behind a proxy without `PRC_TRUST_PROXY=1`, that is one address for everyone. |
| Console says "no producer"; `/api/sessions` returns `NO_BINDING` | No binding row, or the `X-Device-Id` header matches none. |
| Command replies carry `PRODUCER_OFFLINE` or a 502 with that code | The producer socket is not authenticated yet; the client is still fetching its ticket. |
| Desktop logs `ticket_invalid` | A ticket expires after 60 s and is single use. The client asks for a new one on reconnect. |
| Desktop logs `superseded` | A second client connected with the same device id and replaced the live socket. |
| `/healthz` fails | The process is down or the proxy is not forwarding to `127.0.0.1:PRC_PORT`. |
| Console loads but every request returns 401 after a restart | `session-secret` changed or the seven-day cookie expired. Sign in again. |
