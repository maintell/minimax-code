# Desktop Offline Mode — Main-Process Network Fallback Design

Date: 2026-11-09
Status: DRAFT — pending one-shot review (design + plan) before any implementation.

## Summary

A machine with no route to the cloud (or a LAN/captive-portal connection that cannot reach the account servers) must be able to launch the desktop client, stay on the main surface without a white screen, without the "account information unavailable" card and without being redirected to the login window, and use the local runtime for chat. All logic lives in editable main-process TypeScript; the prebuilt, minified renderer bundle is **not** patched. Online behaviour is unchanged.

This is a redesign after four failed attempts at a login-gate bypass. Those attempts either left a residual gate (account bootstrap, 401 interceptor, background re-checks) or, in the last one, injected a forged logged-in state into the minified renderer and caused a white screen. See `Problem` for the root-cause chain.

## Problem

Evidence gathered from the restored client (3.1.10):

- The login gate is a **network**, not a single check: startup surface decision (`windows/manager.ts` → `resolveInitialAuthState`), renderer account bootstrap `useInitFetch` (`out/.../layout-*.js`), `checkAuthStatus` on 4 pages, `navigateToLogin` at 6 sites, an axios 401 interceptor, and `native:user-update` / tab-activate / visibility re-checks.
- The current (11-07) fix makes `resolveSharedOAuthAuthState` return true when a 2s cloud probe fails, so the main surface opens. But `useInitFetch.d()` then calls `getCurrentUser` and remote-config fetches that fail offline, sets `authInitFailed` and shows the error card; the 401 interceptor's `ensureLoggedIn` helper later re-opens the login window.
- The last attempt injected `setUser({isAuthReady:true,isLogin:true,authInitFailed:false}); return` into the minified layout. It set only three flags, skipped all initialization, and the main UI dereferenced missing `userID`/`membershipInfo`/config → React tree crash → white screen. Reverted to `783b2b25`.
- Key data-flow fact: the renderer's `getCurrentUser` does **not** go through the proxy HTTP. It reads a local store via `preload.getUser()` → `ipcMain STORAGE_GET_USER` → `getUserInfo()` (`ipc/storage.ipc.ts`), which returns `store.get('sharedUser'|'user')`. The user object is assembled by `setUserInfo` (`{...existing, ...user}`) and consumed by `syncStoredLocalRuntimeAuthContext` with fields `realUserID / userID / userMail / userName / subUserName`.
- The local runtime only warms up when `authenticatedAtStartup` is true (`lifecycle/application-modules.ts` `local-runtime-warmup`). That flag = `syncStoredLocalRuntimeAuthContext()` = `refreshSharedRuntimeProjection(session,{allowAnonymous:true}).then(Boolean)`. Offline, `getAccessToken` throws `AuthRequiredError`, `allowAnonymous` returns `undefined`, so the flag is false and `prepareLocalRuntime()` is skipped — **chat cannot work** even if the UI is reached.

## Goals

- Offline (cloud unreachable per the existing probe): open the main surface directly.
- No white screen, no `account_init_unavailable` card, no redirect to login for the whole session.
- Chat / local-runtime features usable offline.
- Online (cloud reachable): behaviour is byte-for-byte the current mandatory-login flow.
- Zero edits to the minified renderer bundle; all changes in main-process TS + the existing patch script (only for the retry-budget copy, already present).
- Testable without an Electron host (injectable probe, pure helper functions).

## Non-goals

- Cloud-backed features (model calls that need the account backend, sync, billing) working offline — impossible without a network. BYOK/local model viability is a separate verification item, not guaranteed here.
- Faking real account identity or billing data. The offline identity is an explicit, clearly-labelled synthetic local user.
- Changing the OAuth/token/login flow for online machines.
- Persisting the offline identity across restarts as if it were a real login.

## Architecture

Introduce one authoritative decision, evaluated once per process: `resolveConnectivity()` in a new main module `modules/connectivity/offline-mode.ts`, returning `'online' | 'offline'`. It reuses the existing 2s `net.fetch` cloud probe (from `windows/initial-auth.ts`) with `net.isOnline()===false` fast path, and caches the result. Every offline decision reads this single cached value so the gates cannot disagree.

Three seams, all in main-process TypeScript:

1. **Local identity seam** (`ipc/storage.ipc.ts`): when offline and `getUserInfo()` is empty, `STORAGE_GET_USER` returns a **complete synthetic user object** built by a pure `buildOfflineUser()` helper (all fields the UI and `syncStoredLocalRuntimeAuthContext` read: `userID`, `realUserID`, `userName`, `subUserName`, `userMail`, avatars, plus a sentinel `offline:true`). This is a *read-time* fallback, not a write into the store, so it never masquerades as a persisted real account and disappears when the user goes online. Because the object is complete, the renderer's `getCurrentUser` succeeds and the main UI renders normally — no forged flags, no skipped init, no white screen.
2. **Runtime warmup seam** (`lifecycle/application-modules.ts` + `auth/runtime-projection.ts`): offline, force `authenticatedAtStartup = true` and call `prepareLocalRuntime()` with an empty/anonymous auth context (the runtime already supports `allowAnonymous` and `setLocalRuntimeAuthContext({...null})`). This is the change that makes chat work; it is independent of the UI gates. Verify the local runtime actually becomes ready with no bearer token (explicit acceptance test).
3. **Network + navigation seams** (`ipc/proxy.ipc.ts`, `ipc/auth.ipc.ts`):
   - `AUTH_NAVIGATE_TO_LOGIN`: offline → no-op (all renderer `navigateToLogin` paths converge on this one handler). Online unchanged.
   - `PROXY_FETCH` / `PROXY_STREAM`: offline, instead of letting `net.fetch` reject, return a neutral synthetic `Response` (status 200, an empty-but-well-formed JSON body per the request kind) for the account/config/bot-list calls that `useInitFetch` makes. Any genuine HTTP response still counts as reachable; only transport failure/timeout is stubbed. This prevents the 401/error cascade that re-triggers the login gate. The stub is **generic and schema-tolerant** (mirror the shape the renderer already tolerates on a fresh/empty store), not a hand-crafted copy of every internal DTO.

The existing `checkAuthStatus` (`isLoggedIn: true` via `resolveSharedOAuthAuthState` offline) and startup surface decision stay as they are (11-07 behaviour) — they already work.

## Data flow

```text
app ready
  └─ resolveConnectivity()  (cached: net.isOnline()==false ? offline : 2s probe)
       ├─ offline → startup surface = archon (existing resolveSharedOAuthAuthState)
       │            checkAuthStatus.isLoggedIn = true (existing)
       │            AUTH_NAVIGATE_TO_LOGIN = no-op
       │            STORAGE_GET_USER = buildOfflineUser() (complete object)
       │            authenticatedAtStartup = true → prepareLocalRuntime() (anonymous ctx)
       │            failing PROXY_FETCH → synthetic neutral Response
       │            renderer useInitFetch: getCurrentUser OK, config calls get neutral
       │              responses, authInitFailed stays false, no navigateToLogin
       └─ online  → current 11-07 flow, no fallback active anywhere
```

## Components

| Unit | Responsibility | Depends on |
| --- | --- | --- |
| `modules/connectivity/offline-mode.ts` | cached `isOffline()`, injectable probe, `buildOfflineUser()`, `neutralProxyResponse()` | `electron.net`, existing probe helper |
| `ipc/storage.ipc.ts` | read-time offline user fallback in `STORAGE_GET_USER` | `offline-mode` |
| `ipc/auth.ipc.ts` | no-op `AUTH_NAVIGATE_TO_LOGIN` when offline | `offline-mode` |
| `ipc/proxy.ipc.ts` | return `neutralProxyResponse()` on offline transport failure | `offline-mode` |
| `lifecycle/application-modules.ts` | force runtime warmup offline | `offline-mode` |
| `modules/auth/runtime-projection.ts` | allow anonymous projection offline | `offline-mode` |

## Error handling

- Probe throws → treat as offline (same conservative rule as 11-07).
- `net.isOnline()===false` → offline without a request.
- Synthetic proxy response must match the response envelope `handleProxyFetch` already produces (status, headers, body encoding) so the renderer's parsing does not throw — to be validated against the actual `PROXY_FETCH` return contract during planning.
- If `prepareLocalRuntime()` fails offline, log and keep the UI up; do not fall back to the login window.
- No credentials are written to the store by the offline path.

## Testing

- Pure-unit: `isOffline()` three states (no link, link-but-cloud-unreachable, reachable) + caching; `buildOfflineUser()` field completeness (every field `syncStoredLocalRuntimeAuthContext` reads is present); `neutralProxyResponse()` shape.
- Main-IPC: with an injected offline probe, assert `STORAGE_GET_USER` returns the complete object, `AUTH_NAVIGATE_TO_LOGIN` does not call `switchToLoginWindow`, a failing proxy request yields the stub, and `authenticatedAtStartup` is true / `prepareLocalRuntime` invoked.
- Regression (online): with reachable probe, all of the above return to current behaviour (real login gate, real proxy, real warmup flag).
- Gate suite: `pnpm check`, `pnpm check:source`, `pnpm check:tsconfig`; zero renderer-bundle diff.
- Real-machine acceptance (user): on a no-network machine, launch the packaged build, confirm no card/no login redirect over several minutes, and confirm a chat turn against the local runtime actually runs. This is the decisive test — prior attempts were only statically verified.

## Risks

## Stage 5b correction (2026-11-09, real-machine feedback)

- `getCurrentUser` is NOT a local store read. Module 22668 `ts` = `async w(){let{data:e}=await ZP.get("/v1/api/user/info");return e.data}` — an HTTP request through the proxy. `d()` destructures `{userInfo}` from it; on failure the catch calls `ensureLoggedIn("init:account_unavailable")` and, because `checkAuthStatus.isLoggedIn` is true offline, `o()` sets `authInitFailed` → the error card. So the ONLY fix is making `/v1/api/user/info` SUCCEED with a complete `userInfo`; the `STORAGE_GET_USER` fallback is unrelated to this path.
- Three real implementation bugs found and fixed: (1) the proxy stub was placed in only the last catch branch, after the 401/timeout early returns; moved to the TOP of the catch so every failure shape is covered. (2) `neutralProxyResult` returned `data:{}`; now returns a body whose `data.userInfo` is a complete offline user — verified against the axios adapter (`proxy result.data` is JSON.stringified as the HTTP body, so `w()` returns `body.data` and `d()` reads `body.data.userInfo`). (3) `isOfflineStubPath` was written as a MULTI-LINE regex literal; tsc emitted a broken RegExp at runtime (invisible to `tsc --noCheck`). Rewritten as single-line regexes + prefix/keyword lists, verified by evaluating the emitted function. Whitelist now covers the whole init chain (`/v1/api/user|config`, `/matrix/api/v1/user|commerce|charge`, `/minimax-cloud/api/v1/user|credit`) and explicitly excludes chat/completion/stream/model.
- Residual risk: post-getCurrentUser setters (membership/extra_info/config/bot list) consume the neutral `data:{base_resp:{status_code:0}}`; most have nullish guards but a wrong shape could still throw into the outer catch. Only a real-machine offline run can confirm. The stub now logs `[IPC Proxy] offline stub for <path>` so the next run can prove it fired.
## Stage 5c — the second offline gate: account onboarding (2026-11-09)

- After the proxy stub and the `STORAGE_SET_USER` fix, a fresh no-network install reached the main surface but showed **Invalid desktop onboarding config**. Root cause chain: `STORAGE_GET_DESKTOP_ONBOARDING_MODE` returns `'account-onboarding'` for `installCohort === 'new-install'` (a fresh machine) → the renderer's layout derives `N === 'onboarding'` → its effect calls `tq()`, which fetches `agent_desktop_onboarding_config` and runs it through a validator; our neutral config stub has no such key, the validator returns null, and `tq()` throws.
- Fix (main-side, no renderer patch): `STORAGE_GET_DESKTOP_ONBOARDING_MODE` returns `'main'` when offline. The onboarding flow is cloud-driven and cannot complete offline, and the renderer only calls `tq()` while the derived state is `'onboarding'`.
- Confirmed from the same run's main log that the earlier gates now pass: `[Auth] checkAuthStatus offline=true isLoggedIn=true` appears exactly once (no `ensureLoggedIn` re-check, no `navigateToLogin suppressed`, no `[Renderer:error]`), `[Storage] setUser offline=true realUserID=offline-local`, and `[UtilityRuntime] ready` — i.e. the account card is gone and the local runtime is up.
## Stage 0 spike result (2026-11-09, contracts verified against source)

- `handleProxyFetch` (`ipc/proxy.ipc.ts`) returns `{ok, status, statusText, headers, data}`; its catch already maps transport failures to `{ok:false, status:0, data:null}` and `requiresInteractiveLogin` to a 401 envelope. The neutral stub is injected in that catch — offline + transport failure returns `{ok:true, status:200, headers:{'content-type':'application/json'}, data:<neutral>}`. The renderer's axios layer then sees 200 + valid JSON and never triggers the 401 interceptor / error card. No new response envelope has to be invented.
- `prepareLocalRuntime()` (`modules/local-runtime/index.ts`) = `ensureUtilityRuntimeStarted()` + `startLocalRuntimeServer()`; it never reads a token or auth context. `authenticatedAtStartup` is only a business switch gating warmup, not a technical dependency. Forcing warmup offline is therefore low-risk. **The earlier 'highest-uncertainty item' is resolved**: anonymous runtime startup is viable.

## Risks

- The synthetic proxy `data` must be JSON that the account/config callers tolerate as an empty state; a wrong *value* (not shape — the envelope is known) could still surface a degraded UI. Mitigate by returning the same empty-state payload the renderer already handles and by the real-machine test. A wrong stub here cannot cause a white screen because the offline user object is complete and initialization is NOT skipped.
- Runtime warmup with a null auth context: verified the runtime does not require a token, but the *model/agent layer* may still attempt a cloud call for non-BYOK models. This is an acceptance-check item, not a startup blocker.
- Cached offline decision does not auto-flip when connectivity is restored mid-session (restart required) — acceptable for a no-network target.
- The probe is conservative: a transient network blip on an otherwise-online machine is treated as offline for the whole process (cached). Mitigation: only `net.isOnline()===false` or a real transport failure/2s timeout counts as offline; a slow-but-successful HTTP response counts as reachable. Residual risk: a genuine 2s+ stall at startup could skip login — accepted for the no-network target, and recoverable by restart.
- Any new file under `docs/` must be recorded in `release/public-source.json` (AGENTS.md); this spec + plan are the intended deliverables and will be inventoried.
