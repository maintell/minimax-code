# MiniMax Code desktop changelog

This changelog covers the Windows desktop client (`apps/electron`). It is the
source of the GitHub release notes: the `Desktop release` workflow publishes the
section for the released version, so a version without a section cannot be
released. Keep entries user-facing; internal refactors, test-only changes and
packaging changes that do not alter behavior do not need an entry.

## 3.1.19 · 2026-11-26

### Changed

- Client 3.1.19: refreshed renderer bundle and model menu, a new `pptx-core`
  wasm module set, an updated session-transfer client and rebuilt vendored
  native binaries.
- Screenshot and selection capture now run through the main process: region
  capture with a selection mask, window capture, annotation controls and
  capture permissions.
- Mini-app files can be opened from a conversation, the model menu gained its
  advisor and limit logic, and browser pages gained takeover and scroll-guard
  helpers.
- The Windows installer stays per architecture; this release ships the x64
  package (`MiniMax Code Setup 3.1.19-x64.exe`).

### Fixed

- A manual update check that races the background metadata probe no longer
  leaves the updater stuck on "checking": both paths now wait for the in-flight
  probe instead of starting a second check.

## 3.1.15 · 2026-11-15

### Changed

- Client 3.1.15: refreshed renderer bundle and model menu, a new `pptx-core`
  wasm module set (`Pptx.Importer`, `Pptx.Importer.Wasm`, `Pptx.SafeOpc`), an
  updated session-transfer client and rebuilt vendored native binaries.
- The main process gains mini-app content preview, browser JavaScript-dialog
  handling, a preview-host guard, UI metrics, a quota auto-resume wake, desktop
  metrics and an extra crash guard.
- The Windows installer is published per architecture from 3.1.15 on; this
  release ships the x64 package (`MiniMax Code Setup 3.1.15-x64.exe`).

### Fixed

- Starting offline on a profile that had signed in before no longer stops on the
  "account information unavailable" card: the offline path now keeps the account
  identity already stored on the machine instead of substituting a local one.

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
