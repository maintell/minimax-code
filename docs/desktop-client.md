# Desktop client (`apps/electron`)

The repository publishes the MiniMax Code CLI packages under `packages/**` and
now also carries the desktop client of the product: the Electron application
whose shell, main process, renderer bundle and runtime resources are recovered
from the publicly distributed Windows build. The application itself lives in
[`apps/electron`](../apps/electron/README.md); the recovery record — what was
recovered, how it was verified and every known deviation — lives in
[`apps/electron/RESTORATION.md`](../apps/electron/RESTORATION.md).

## Working on it

```sh
cd apps/electron
pnpm install --ignore-workspace   # standalone install; not part of the workspace
pnpm build                        # tsc -> dist/main + prebuilt assets
pnpm check                        # syntax/emit check of the recovered sources
pnpm start                        # stage dist/app and launch the local Electron
pnpm package                      # electron-builder -> dist/installers
```

The package is deliberately **outside** the workspace and outside
`release/extraction.json`:

- Its first-party dependencies (`vendor/**`) are a different, separately
  shipped revision than the `packages/**` sources; mixing them in one
  resolution graph would break both. The vendor snapshots are pinned with
  `file:` dependencies and their manifests are rewritten by the restore
  pipeline (see `apps/electron/RESTORATION.md` → "Vendor manifest rewrites").
- It is an application, not a library consumed by the standalone CLI bundle,
  so it does not participate in `packageRoots`, `pnpm gen:tsconfig`, the
  Vitest aliases or the standalone build. `apps/electron/dist` and
  `apps/electron/node_modules` are build outputs and never committed.

`check:source` does scan the tree, and the published files are recorded in
`release/public-source.json` like any other file.

## Publication exceptions

The desktop client is a public product: everything committed here is
byte-identical to what the published installation ships, including inert
strings that the general internal-source check rejects (test-environment
`*.xaminim.com` endpoints, build-machine paths embedded in prebuilt wasm/bundle
artifacts, and the first-party thrift-generated client package names the runtime
requires).

Those strings are exempted one by one in
[`scripts/lib/published-client-exceptions.mjs`](../scripts/lib/published-client-exceptions.mjs):
each entry names a file and the exact matched strings inside it. The check
still fails for any new string in a listed file and for any string anywhere
else in the repository.

When the client tree is updated (a new build is restored), the exception list
must be reviewed together with the restored files: run
`pnpm check:source` and either remove the string or extend the list
deliberately.
