# Desktop client restoration report

This document records what was recovered from the installed client, how, what
was verified, and every known deviation. The recovery pipeline itself lives in
[`tools/restore/`](./tools/restore/README.md) so reviewers can re-run it against
a locally installed client.

## Source

| | |
| --- | --- |
| Installed client | `MiniMax Code` 3.1.6 (`%LOCALAPPDATA%\Programs\MiniMax Code`) |
| Application | `@mmx-agent/electron` 3.1.6, Electron 42.8.0 (Chromium 148), `buildEnv=prod`, locale `zh` |
| Identity | appId `com.minimax.agent.cn`, runtime app name `MiniMax`, user data `%APPDATA%\MiniMax` |
| Package | `resources/app.asar` (353 MB), `resources/app.asar.unpacked`, `resources/resources/**` |

Version history of this recovery:

| App | Date | Notes |
| --- | --- | --- |
| 3.1.6 | 2026-10-27 | Current. Renderer assets moved out of `public/`: the shipped `public/` keeps only the six files the main process and the plugin pages load, and `out/assets/**` carries the images. New packaged Computer Use component (`resources/computer-use/0.34.1/win32-x64/**`) and the vendored `@mavis/computer-use` package it is driven by; mini-app speech/tool IPC, browser device-preview and permission-panel modules are new. `pptx-core` moved to a new content hash. Main process: 357 files (was 346). |
| 3.1.4 | 2026-10-20 | New `@minimax/mcode-app-server-protocol` dependency, an SSH runtime (`main/modules/ssh-runtime/**`), mini-app agent IPC and detached windows; the Word/Excel editor IPC modules are gone. Renderer grew ~14 MB. |
| 3.1.1 | 2026-10-17 | Initial recovery. |

## What was recovered

| Part | Method | Fidelity |
| --- | --- | --- |
| Main process (`main/**`) | The shipped `dist/main` is per-file `tsc` CommonJS output with comments preserved. `tools/restore/convert-main.mjs` reverses every emitted pattern (imports, re-exports, dynamic imports, declaration-form exports) back to TypeScript using the TypeScript compiler API and text-level replacement, keeping comments and formatting. | Recompiling the recovered sources with tsc 5.9.3 (`target: ES2022`, `module: commonjs`, `esModuleInterop`) reproduces **352 of 357 files byte-identically**; the remaining 5 files differ only in the *order* of adjacent export-assignment statements, and one of them additionally inlines an arrow function into its export assignment (9 lines total, semantically inert). See "Verification" below. |
| Renderer (`out/**`) | Committed as the prebuilt static Next.js export. | Byte-identical to the shipped `out/`. The upstream UI sources are not part of this distribution and the build carries no source maps, so a source recovery is not possible. |
| `public/**` | Committed as-is from the shipped app root. | Byte-identical. 3.1.6 moved the renderer images into `out/assets/**`, so only six files remain: the prompt-config key carriers the main process reads (`public/assets/img/breakDown.png`, `computer_use.png`, see `main/config/prompt-config-key.ts`) and four plugin/permission images the renderer loads. The directory stays a runtime dependency, not only renderer input. |
| Model menu (`model-menu/**`) | Committed as the prebuilt Vite build output. | Byte-identical. |
| Prebuilt preload bundle (`main/modules/browser/miniapp-preload.bundle.js`) | Copied verbatim (esbuild output; banner references `main/modules/browser/preload.ts`). | Byte-identical. |
| Runtime resources (`resources/mcode-tools`, `pptx-core`, `session-transfer`, `computer-use`) | Copied from `<install>/resources/resources/`. | Byte-identical. `computer-use/` is the packaged Computer Use component (v0.34.1, `win32-x64`), which the main process locates at `process.resourcesPath/resources/computer-use`. |
| Build resources (`resources/icon.ico`, `installer-*.nsh`, DMG assets, entitlements, tray icons) | Copied from `<install>/resources/resources/`; the electron-builder configuration was reconstructed around them (`directories.buildResources: resources`, `extraResources: resources -> resources`). | Files byte-identical; the packaging configuration is reconstructed (see deviations). |
| Dependency snapshots (`vendor/**`) | Runtime files of every first-party and native package the client actually loads, extracted from the shipped `node_modules` (+ `app.asar.unpacked` overlays). Manifests are rewritten for local `file:` resolution. | Code byte-identical; manifests rewritten (see "Vendor manifest rewrites"). |
| Environment file (`env/prod-zh.env`) | The shipped `.env.local` (prod/zh lane), mapped to `.env.local` inside the app package at build time. | Byte-identical content. |

## Verification

1. **Emit equivalence.** `tools/restore/verify-main.mjs` compiles `main/**` with
   the app `tsconfig.json` and diffs every emitted file against the shipped
   `dist/main`. Result: 352/357 identical, 5 files with export-order-only
   differences (`config/env.js`, `ipc/documentPreview.ipc.js`,
   `modules/desktop-appearance.js`, `modules/document-preview/artifact-protocol.js`,
   `modules/local-runtime/computer-use/component-release.js`),
   1 prebuilt bundle copied verbatim. The differences are caused by information
   the CommonJS build erases (the position of bare `export {}` re-export
   statements, the hoisting order of exported function assignments, and whether
   an exported arrow function is inlined into its `exports.x = …` assignment);
   they do not change any runtime behaviour.
2. **Packaged-run verification.** `pnpm package` produces
   `dist/installers/win-unpacked/` and the NSIS installer. Launching the packaged
   executable with an isolated profile (`--user-data-dir`, and a desktop-store
   `config.localRuntimeDataParentDir` pointing at an isolated directory) boots
   the client end to end: the main process starts, the `app://` protocol serves
   the renderer from `out/`, the local-runtime utility process reaches the
   `modules-loaded` bootstrap stage, and mcode-tools initializes its launchers
   and auth-lease endpoint in the isolated data directory.
   Two defects were found and fixed during this verification:
   - `public/**` must ship at the app root: the main process reads the
     prompt-config key carriers from `public/assets/img/*.png`
     (`main/config/prompt-config-key.ts`), so the directory is a runtime
     dependency and not only renderer input.
   - Vendored manifests must not keep a `files` field: package managers filter
     `file:` copies by it, and better-sqlite3's `files` omits its prebuilt
     `build/` directory, which silently dropped the native module.
3. **Contract checks.** `check:source` scans this tree; the exact internal
   string exemptions are declared in
   `scripts/lib/published-client-exceptions.mjs` and documented in
   `docs/desktop-client.md`.

## Known deviations

1. **Export-order-only diffs** — the 5 files listed above; 9 lines total.
2. **Erased type annotations.** The shipped build erased all TypeScript types.
   The recovered sources compile to the same JavaScript but do not satisfy a
   full type check (`pnpm typecheck:strict` reports ≈5.3k diagnostics, dominated
   by object-literal widening and optional-parameter arity that the original
   annotations used to describe). `pnpm build` and `pnpm check` (syntax/emit)
   are the supported checks; re-adding annotations is follow-up work.
3. **`@mavis/electron-runtime-fetch-devtools` is absent.** The shipped client
   also lacks this package (it is a development helper; the loader wraps the
   `require` in a `try/catch` that logs a warning). The restored build behaves
   identically: the extension is skipped with a logged warning.
4. **Development lanes.** Only the shipped prod/zh `.env` lane exists in the
   installation; `pnpm start` runs the packaged lane (no dev server). The
   renderer's dev-server mode (`NODE_ENV=development`) would require the
   upstream UI sources, which are not part of this distribution.
5. **Packaging configuration is reconstructed.** electron-builder options
   (NSIS script wiring, `asarUnpack` list, `extraResources` mapping, updater
   publish URL) were rebuilt from the installed layout and the shipped NSIS
   scripts. The `asarUnpack` list mirrors `app.asar.unpacked` exactly; the
   installer artifact name uses electron-builder's default.
6. **Vendor manifest rewrites** — see below.
7. **One vendored runtime file carries a deliberate local patch** — the fixed
   three-second retry cadence in `@mavis/agent-core`'s `llm-retry.js`; see
   "Local modifications to vendored snapshots".
8. **`resources/resources/**` ships build resources at runtime.** The shipped
   installation contains the NSIS/DMG assets inside `resources/resources/`; the
   reconstruction preserves that layout.

## Vendor manifest rewrites

`vendor/**` package manifests are rewritten by the restore pipeline so the
snapshot resolves locally and contains no development-only metadata:

- `scripts`, `devDependencies`, `publishConfig`, `resolutions`, `pnpm` fields
  are removed (the shipped `publishConfig` entries point at an internal npm
  mirror).
- `types` entries (and `types` conditions in `exports`) are removed: the
  shipped manifests point them at `src/**`, which the runtime snapshot
  intentionally does not carry.
- Dependencies on other vendored packages are rewritten to `file:` paths;
  `workspace:` specifiers are resolved the same way.

No runtime JavaScript of a vendored package is modified, with one deliberate
exception documented below.

## Local modifications to vendored snapshots

| File | Change | Reason |
| --- | --- | --- |
| `vendor/@mavis/agent-core/dist/pi-turn-runner/llm-retry.js` | Provider errors retry without a practical limit (`2_147_483_647` attempts — the largest serialisable integer, since the retry-event contract requires a non-negative integer) on the fixed `baseDelayMs` cadence (3 s), with no backoff, no jitter and no wall-clock budget. A server-directed `Retry-After` header still wins. The retry decision is the same for every provider, not only BYOK: the strict classification keeps its precise transient reason (timeout, network, 429, overload, 5xx, empty response), and a failure it would fail closed on — an upstream fault no signal matched — is retried too. Task-level outcomes stay terminal: a wrong credential (`auth`), an exhausted usage plan (`usage_limit`), exhausted credits (`credits_exhausted`), deterministic request rejections (413 / oversized body, context overflow, image limit, HTTP 400 `invalid_request_error`) and provider safety refusals. The `done`-event commit shortcut is dropped so a stream that ends without visible output is still validated through `stream.result()`. | Unstable upstreams must recover without user intervention; mirrors the same change in `packages/agent-core/src/pi-turn-runner/llm-retry.ts` so the desktop runtime and the CLI behave identically. The terminal carve-outs matter more under the unbounded budget: retrying a bad key or an empty account can never succeed, it only hides the actionable error. |
| `vendor/@mavis/shared/dist/llm-error-classifier.js` | `ERR_INCOMPLETE_CHUNKED_ENCODING`, `ERR_EMPTY_RESPONSE` and `ERR_QUIC_PROTOCOL_ERROR` join the transient-network marker set, and 5xx responses plus empty provider responses classify as retryable (`server_error` / `empty_response`). Deterministic-rejection signals (`image_limit`, `invalid_request`, `request_too_large`, `context_overflow`) and the exported `isLLMDeterministicRequestRejection` are backported. | A dropped or truncated response body is the classic flaky-upstream shape, and an HTTP/3 failure below the request layer (a proxy or middlebox mangling QUIC) is the same transient transport shape — the resend renegotiates over TCP; mirrors `packages/shared/src/llm-error-classifier.ts`. |
| `out/_next/static/chunks/*.js` (renderer string table) | The retry banner copy drops the attempt cap: `({{attempt}}/{{total}})` becomes `({{attempt}}/∞)`, in both the English and the Chinese tables. | The renderer is a prebuilt artifact, so the budget is presented by rewriting its plain strings; otherwise an unbounded budget would read `(3/2147483647)`. The TUI uses `formatRetryBudget()` from `@mavis/shared/llm-retry-event` for the same result. |

The two vendored snapshots are otherwise byte-identical to the shipped build,
and the renderer differs only in those four retry strings. Each code patch is a
few lines marked with a `Local patch:` comment. None of this is hand-edited:
`tools/restore/apply-local-patches.mjs` re-applies everything after every
re-vendoring, works on an already-patched tree, and asserts each anchor — a
shipped refactor of the retry loop, the classifier or the retry copy fails
loudly instead of silently restoring the shipped behaviour.

## Dependency closure

Third-party dependencies are installed from npm at the exact versions the
shipped client resolved for its direct dependencies, and `package.json`
(`pnpm.overrides`) pins the rest of the closure:

- Single-version packages are pinned to the shipped version.
- Packages missing from a fresh resolution are added back at the shipped
  version.
- Multi-version packages are **not** force-pinned: the shipped tree itself
  keeps several copies of them (pnpm nests per range), and forcing one version
  breaks consumers (for example `readable-stream` 4 has no `passthrough`
  subpath that `lazystream` requires, and `chalk` 5 is ESM-only while
  electron-builder needs the CommonJS API). The same applies to the
  development toolchain: `chalk`, `builder-util-runtime` and the scoped
  overrides whose parent exists at several versions are deliberately left to
  pnpm's per-range resolution.

A comparison against the shipped `node_modules` (`tools/restore/README.md`
describes the procedure) shows the same version *sets* for the pinned packages;
the remaining differences are hoisting positions (which copy sits at the top of
`node_modules`) and a small set of multi-version packages where a fresh
resolution legitimately picks a different copy than the original lockfile did.
Both trees satisfy every dependency range.

## Packaging notes

- `.env.local` is written by `scripts/package.mjs` for the duration of the
  packaging run (from `env/prod-zh.env`) and removed afterwards: the
  repository never stores a `.env*` file, and the packaged app still finds its
  environment file at the app root.
- `asarUnpack` mirrors the installed `app.asar.unpacked` set exactly;
  `npmRebuild` is disabled because the native modules are the shipped Electron
  42 binaries.
- `resources/` is used both as electron-builder's `buildResources` directory
  and as the `extraResources` source, which reproduces the installed
  `resources/resources/**` layout.

## Repository integration notes

- The package is intentionally **not** a member of the pnpm workspace: its
  first-party dependencies are a different, separately shipped revision than
  the `packages/**` sources in this repository. Install it standalone with
  `pnpm install --ignore-workspace`.
- It is intentionally **not** listed in `release/extraction.json`
  (`packageRoots`): it is an application, not a library consumed by the
  standalone CLI bundle, and its build pipeline is `tsc` + electron-builder
  rather than the workspace pipeline.
- `apps/electron/dist/**` and `apps/electron/node_modules/**` are build outputs
  and are never committed.
