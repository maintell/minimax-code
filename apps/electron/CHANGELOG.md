# MiniMax Code desktop changelog

This changelog covers the Windows desktop client (`apps/electron`). It is the
source of the GitHub release notes: the `Desktop release` workflow publishes the
section for the released version, so a version without a section cannot be
released. Keep entries user-facing; internal refactors, test-only changes and
packaging changes that do not alter behavior do not need an entry.

## 3.1.14 · 2026-11-11

### Changed

- Client 3.1.14: refreshed renderer bundle and model menu, the `pptx-core`
  runtime (new `Pptx.Importer` and `Pptx.SafeOpc` wasm modules) and the vendored
  native binaries.
- The packaged runtime lane is the zh/prod lane shipped by 3.1.14
  (`agent.minimax.cn`, `chat.minimaxi.com`, `account.minimax.cn`); earlier builds
  carried the en lane.
- Update checks now read this repository's GitHub releases: the client resolves
  the newest `desktop-v*` release and loads its `latest.yml` instead of the
  upstream CDN, which could offer an official MiniMax build.
- Release notes are published from this file, so the release page and the
  changelog always agree.

3.1.13 and earlier check the upstream CDN, so this build has to be installed
manually once. Later releases update from this repository's GitHub releases.
