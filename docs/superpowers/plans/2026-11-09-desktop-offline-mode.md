# Desktop Offline Mode — Implementation Plan

Date: 2026-11-09
Companion: `docs/superpowers/specs/2026-11-09-desktop-offline-mode-design.md`
Status: DRAFT — one-shot review together with the design; no code until approved.

## Preconditions

- Working tree back at `783b2b25` (11-07 stable, white screen reverted) — verified.
- Baseline local `win-unpacked` rebuilt from that commit — verified.
- Branch: `feat/desktop-client` (feature branch; PR to default branch per AGENTS.md).

## Stage 0 — Contract verification spike (highest uncertainty first)

Before writing the fallback, prove the two riskiest assumptions with throwaway probes (no product code committed):
1. Read the full `PROXY_FETCH` return contract in `ipc/proxy.ipc.ts` (`handleProxyFetch` → response envelope: status, headers, body, stream events). Record the exact shape `neutralProxyResponse()` must mimic.
2. Confirm `prepareLocalRuntime()` reaches `ready` with `setLocalRuntimeAuthContext({accessToken:null, ...})` and no bearer. If it hard-requires a token, document the gap and revise the design's Goal 3 (chat) before continuing — do NOT ship a UI that looks usable but cannot chat.
Exit: both facts written into the design's Risk/Components sections; if chat cannot run anonymously, return to the user for a scope decision.

## Stage 1 — Single connectivity decision

- Add `apps/electron/main/modules/connectivity/offline-mode.ts`: `configureConnectivityProbe(probe)`, cached `isOffline()`, `buildOfflineUser()`, `neutralProxyResponse()`. Reuse the existing 2s `net.fetch` probe logic currently in `windows/initial-auth.ts` by extracting it (keep `resolveSharedOAuthAuthState` behaviour identical).
- Wire `windows/initial-auth.ts` to `isOffline()` so startup / checkAuthStatus keep working. No behaviour change online.
- Unit tests (node, stubbed `electron`): three connectivity states, cache, user-object completeness, stub shape.
- Gate: `pnpm check`, `check:source`, `check:tsconfig`.

## Stage 2 — Navigation + local identity seams

- `ipc/auth.ipc.ts`: `AUTH_NAVIGATE_TO_LOGIN` no-op when `isOffline()` (all renderer jump paths converge here).
- `ipc/storage.ipc.ts`: `STORAGE_GET_USER` read-time fallback to `buildOfflineUser()` when offline and store is empty.
- Do NOT touch the renderer bundle. Assert `git diff` has zero `out/_next/static/chunks` changes.
- Tests: offline `getUserInfo`-equivalent returns complete object; `switchToLoginWindow` not called offline; online unchanged.

## Stage 3 — Local runtime warmup

- `lifecycle/application-modules.ts`: offline → `authenticatedAtStartup = true` so `local-runtime-warmup` runs.
- `modules/auth/runtime-projection.ts`: offline anonymous projection (empty context) instead of throwing.
- Verify via Stage 0 spike result; add a test that `prepareLocalRuntime` is invoked offline.

## Stage 4 — Proxy transport fallback

- `ipc/proxy.ipc.ts`: on offline transport failure in `performProxyNetFetch` / `fetchProxyResponse`, return `neutralProxyResponse()` (Stage 0 shape) rather than rejecting, so no 401/error cascade re-opens the login gate.
- Scope the stub to the account/config/bot-list request kinds `useInitFetch` issues; leave real model/stream traffic to fail normally (cloud-dependent).
- Tests: offline failing fetch → stub; online → real fetch; stub never returned when a genuine HTTP response arrived.

## Stage 5 — Verification

- Full gate suite; confirm zero renderer diff; patch script unchanged (no new renderer anchors).
- Local `--dir` win-unpacked build (TMP/TEMP on F:), assert `app.asar` contains the new main module and no forged-state injection.
- **Real-machine offline acceptance (decisive, user-run)**: install/launch on a no-network machine; confirm (a) main surface, (b) no white screen, (c) no account-info card, (d) no login redirect over several minutes including tab switching / reconnect events, (e) a chat turn actually runs on the local runtime.
- Report checks actually run and any untested boundaries honestly (per AGENTS.md).

## Stage 6 — Delivery (only after acceptance passes)

- Commit on `feat/desktop-client`, push, force-move `desktop-v3.1.10` tag, one Desktop release workflow run, clobber release assets (per established release flow).
- Note: version unchanged → existing installs may not auto-update; user must re-download. Call this out at delivery.

## Rollback

- Code: `git checkout 783b2b25 -- <files>` (all changes are in main TS, no generated/binary files).
- Local artifact: rebuild `--dir` from the reverted tree (already proven in this session).
- Release: re-run the workflow from the previous tag commit if a bad build was published (same force-tag mechanism).

## Explicitly out of scope for implementation until review

- No design-doc commit / inventory regeneration until the user approves both documents (they are untracked drafts; `pnpm check:source` will flag them as `Added` until inventoried — keep them out of any gate run that must be green, or inventory them as the deliverable).
- No release/tag action during Stages 0–5.
