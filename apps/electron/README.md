# MiniMax Code desktop client (`@mmx-agent/electron`)

This package is the desktop client of MiniMax Code: the Electron application
whose shell, main process, renderer bundle and runtime resources were restored
from the publicly distributed Windows build (`MiniMax Code` 3.1.4, Electron
42.8.0). See [RESTORATION.md](./RESTORATION.md) for exactly what was recovered,
how, and which parts are shipped as prebuilt artifacts.

## Layout

| Path | Content |
| --- | --- |
| `main/**` | Electron main process, restored TypeScript sources (compiled to `dist/main` with tsc). `main/modules/browser/miniapp-preload.bundle.js` is a prebuilt esbuild artifact and is copied verbatim. |
| `model-menu/**` | Prebuilt model-menu popup renderer (Vite build output). Copied to `dist/model-menu` at build time. |
| `out/**` | Prebuilt renderer: the static Next.js export that the main process serves over the `app://` protocol. Committed as-is because the upstream UI sources are not part of this distribution and the build carries no source maps. |
| `public/**` | Static assets served alongside `out/`; the main process also reads the prompt-config key carriers from `public/assets/img/*.png` at runtime. |
| `resources/**` | electron-builder build resources (icons, NSIS scripts, DMG assets, entitlements) and the runtime `extraResources` (`mcode-tools`, `pptx-core`, `session-transfer`), mirroring the shipped installation. |
| `vendor/**` | Runtime dependency snapshots at the exact revisions used by the shipped client (`@mavis/*`, `@earendil-works/pi-*`, `@minimax/mcode-sandbox-runtime`, and the native modules). The workspace packages under `packages/` are a different, separately reviewed revision and are intentionally not used here. |
| `env/prod-zh.env` | The packaged runtime environment file (the shipped `.env.local` for the zh/prod lane), mapped to `.env.local` inside the app package at build time. |
| `scripts/**` | Build, stage and package entry points. |
| `tools/restore/**` | The restoration pipeline (ASAR extraction, TypeScript source recovery, compiled-output verification). Kept so reviewers can re-run and verify the recovery against a locally installed client. |

## Build and run

This package is installed standalone; it is not a member of the repository
workspace, so its dependency graph never mixes with the CLI packages:

```sh
cd apps/electron
pnpm install --ignore-workspace     # installs Electron, electron-builder, and pinned npm dependencies
pnpm build                          # tsc -> dist/main, copy prebuilt bundle and model-menu
pnpm typecheck                      # type-check the restored main process
pnpm start                          # stage dist/app and launch the local Electron
pnpm package                        # build + electron-builder -> dist/installers
```

`pnpm start` stages `dist/app` (package.json, `.env.local`, `dist/`, `out/`,
`resources/`, `node_modules/`) and launches Electron against it. Set
`MMX_USER_DATA_DIR` to run with an isolated profile so the instance does not
collide with an installed client's single-instance lock.

`pnpm package` writes `dist/installers/win-unpacked/` and an NSIS installer.
Native modules are shipped prebuilt for Electron 42 (extracted from the
installed client), therefore `npmRebuild` is disabled in
`electron-builder.yml` and no local toolchain is required.

## Dependency policy

- First-party and native dependencies are vendored from the shipped client
  (`vendor/**`) and referenced with `file:` so the runtime behaves exactly like
  the installed build. `tools/restore/README.md` documents the extraction and
  the manifest rewrites that the snapshot applies.
- Third-party dependencies are installed from npm at the exact versions the
  shipped client resolved (see `package.json`).
- Nothing in this package participates in the workspace gates
  (`packageRoots`, `pnpm gen:tsconfig`, the standalone bundle), and its
  `node_modules`/`dist` never enter the public source inventory.

## Known deviations from the installed build

See `RESTORATION.md` → "Known deviations".
