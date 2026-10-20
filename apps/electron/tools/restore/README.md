# Restoration tooling

These scripts recover the desktop client tree from a locally installed
MiniMax Code build. They are kept so the recovery can be re-run and verified
against the shipped artifacts instead of being taken on trust. The result and
every known deviation are recorded in [`../../RESTORATION.md`](../../RESTORATION.md).

## Pipeline

```sh
node restore-client.mjs --install-dir "%LOCALAPPDATA%\Programs\MiniMax Code" \
                        --out-dir <repo>/apps/electron
```

1. **Extract** — `asar-extract.mjs` reads `resources/app.asar` without
   modifying the installation (header-driven, no `asar` dependency).
2. **Recover the main process** — the shipped `dist/main` is per-file `tsc`
   CommonJS output. `convert-main.mjs` reverses every emitted pattern
   (named/default/namespace imports, `export {}` re-exports, `__exportStar`,
   dynamic `import()`, declaration-form exports, the `void 0` prologue) back to
   TypeScript with the TypeScript compiler API plus text-level replacement, so
   comments and formatting survive. `main/modules/browser/miniapp-preload.bundle.js`
   is an esbuild artifact and is copied verbatim.
3. **Copy prebuilt content** — `out/`, `public/`, `model-menu/` and
   `resources/` are byte-identical copies of the shipped files.
4. **Vendor snapshots** — the first-party and native packages the client loads
   are copied out of the asar's `node_modules` (with `app.asar.unpacked`
   overlays), pruned of development material (`src`, `docs`, tests, configs,
   markdown) and given rewritten manifests: `scripts`/`devDependencies`/
   `publishConfig`/`resolutions`/`pnpm`/`repository`/`bugs`/`homepage` are
   dropped, `files` is dropped (it would make package managers filter the copy
   — better-sqlite3's `files` omits its prebuilt `build/`), `types` entries are
   dropped (they point at the pruned sources), and dependencies on other
   vendored packages become `file:` references.
5. **Environment lane** — the packaged `.env.local` becomes
   `env/prod-zh.env`; the repository never stores a `.env*` file.

Third-party dependencies are not vendored: `package.json` pins them to the
versions the shipped client resolved, with `pnpm.overrides` covering the rest
of the closure (see `RESTORATION.md` → "Dependency closure").

## Verifying a recovery

```sh
# 1. extract the shipped build output for comparison (scratch directory)
node asar-extract.mjs "%LOCALAPPDATA%\Programs\MiniMax Code\resources\app.asar" <scratch> dist

# 2. build the recovered tree and diff every emitted file
cd <repo>/apps/electron && pnpm build
node tools/restore/verify-main.mjs <scratch>/dist/main dist/main
```

`verify-main.mjs` does not compile anything itself (run `pnpm build` first) and
diffs every emitted file against the shipped `dist/main` after normalizing line
endings and trailing whitespace. The current recovery reproduces 285 of 290
shipped files byte-identically; the four remaining files differ only in the
order of adjacent export assignments (information the CommonJS build erases),
and one file is a prebuilt bundle copied verbatim.

`--details=<file>` writes a per-line diff report for the remaining files.

## Local behavioural patches

The shipped client retries a failed model request with exponential backoff and a
five-attempt / two-minute budget, and treats a dropped response body (`5xx`,
`net::ERR_INCOMPLETE_CHUNKED_ENCODING`, empty response) as terminal. This product
wants the opposite: provider errors retry without a practical limit, on a fixed
three-second cadence.

That is a behavioural change, not a recovery artefact, so it is applied by
[`apply-local-patches.mjs`](./apply-local-patches.mjs) after vendoring:

```sh
node tools/restore/apply-local-patches.mjs      # patches vendor/** in place
```

The script asserts every anchor it edits, so a shipped build that refactors the
retry loop or the classifier fails loudly here instead of silently reverting to
the shipped defaults. `RESTORATION.md` records the patched files.

## Re-running on a new shipped build

1. Run the pipeline against the new installation.
2. Re-apply the local patches (`apply-local-patches.mjs`).
3. Update `package.json`: the app version, any new vendored dependency, and the
   third-party versions the new build resolved.
4. `pnpm install --ignore-workspace`, then `pnpm build`; run `verify-main.mjs`
   and review every reported difference.
5. `pnpm package`, then boot the packaged client with an isolated profile and
   check the main log for errors.
6. Re-run `pnpm check:source` in the repository root and review the
   `scripts/lib/published-client-exceptions.mjs` list against the restored
   files (see `docs/desktop-client.md`).
