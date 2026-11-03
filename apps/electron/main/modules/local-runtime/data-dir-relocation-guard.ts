import * as path from "node:path";
/**
 * Post-relocation health guard.
 *
 * Pre-flight checks cannot prove that the Runtime will start from the new data directory
 * (antivirus locks, unusual storage stacks, permissions that only fail under load). The
 * relocation therefore commits a pending-verification marker together with the new
 * directory. The first Runtime ready on that directory clears it. A terminal Runtime
 * failure, or repeated launches whose Runtime start never reached ready, restore the
 * previous directory, which relocation always keeps intact. The new directory stays in
 * the history list so the user can switch back to it later without copying again.
 *
 * Launches are counted only when a Runtime start is attempted: a signed-out launch never
 * starts the Runtime and says nothing about the directory.
 *
 * This module stays free of Electron and config-store imports: the caller injects them.
 */
/**
 * Runtime start attempts on the new directory that may end without ready before rollback.
 * Terminal Runtime failures roll back at once; this bound covers hangs and app crashes,
 * with headroom for a user who quits during a slow first start.
 */
export let DATA_DIR_VERIFICATION_MAX_UNREADY_LAUNCHES = 3;
function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
export function createPendingVerification(targetParentDir, previousConfig, now = Date.now()) {
    return {
        targetParentDir,
        previousConfig: {
            ...(previousConfig.localRuntimeDataParentDir !== undefined
                ? { localRuntimeDataParentDir: previousConfig.localRuntimeDataParentDir }
                : {}),
            ...(previousConfig.localRuntimePreviousDataParentDirs !== undefined
                ? { localRuntimePreviousDataParentDirs: previousConfig.localRuntimePreviousDataParentDirs }
                : {}),
        },
        unreadyLaunches: 0,
        createdAtMs: now,
    };
}
export function readPendingVerification(value) {
    if (!value || typeof value !== 'object')
        return null;
    const candidate = value;
    const previous = candidate.previousConfig;
    if (typeof candidate.targetParentDir !== 'string' ||
        !candidate.targetParentDir.trim() ||
        !previous ||
        typeof previous !== 'object' ||
        (previous.localRuntimeDataParentDir !== undefined &&
            typeof previous.localRuntimeDataParentDir !== 'string') ||
        (previous.localRuntimePreviousDataParentDirs !== undefined &&
            !isStringArray(previous.localRuntimePreviousDataParentDirs)) ||
        typeof candidate.unreadyLaunches !== 'number' ||
        !Number.isInteger(candidate.unreadyLaunches) ||
        candidate.unreadyLaunches < 0) {
        return null;
    }
    return {
        targetParentDir: candidate.targetParentDir,
        previousConfig: createPendingVerification('', previous).previousConfig,
        unreadyLaunches: candidate.unreadyLaunches,
        createdAtMs: typeof candidate.createdAtMs === 'number' ? candidate.createdAtMs : 0,
    };
}
export function readRollbackNotice(value) {
    if (!value || typeof value !== 'object')
        return null;
    const candidate = value;
    if (candidate.reason !== 'runtime-failed' && candidate.reason !== 'not-ready')
        return null;
    return {
        reason: candidate.reason,
        ...(typeof candidate.reasonCode === 'string' ? { reasonCode: candidate.reasonCode } : {}),
        atMs: typeof candidate.atMs === 'number' ? candidate.atMs : 0,
    };
}
function sameDir(a, b, platform) {
    const left = path.resolve(a.trim());
    const right = path.resolve(b.trim());
    return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
/** The marker only applies while the configured directory is still its target. */
function markerMatchesConfig(marker, config, platform) {
    return (typeof config.localRuntimeDataParentDir === 'string' &&
        sameDir(config.localRuntimeDataParentDir, marker.targetParentDir, platform));
}
/** Reads the marker; drops it when it is malformed or no longer matches the configured dir. */
function readActiveMarker(config, saveConfig, platform) {
    if (config.localRuntimeDataDirPendingVerification === undefined)
        return null;
    const marker = readPendingVerification(config.localRuntimeDataDirPendingVerification);
    if (!marker || !markerMatchesConfig(marker, config, platform)) {
        saveConfig({ localRuntimeDataDirPendingVerification: undefined });
        return null;
    }
    return marker;
}
export function buildRollbackPatch(marker, notice, platform) {
    const previousDirs = marker.previousConfig.localRuntimePreviousDataParentDirs ?? [];
    const previousParent = marker.previousConfig.localRuntimeDataParentDir;
    const keepTarget = !previousDirs.some((dir) => sameDir(dir, marker.targetParentDir, platform));
    const historical = (keepTarget ? [marker.targetParentDir, ...previousDirs] : previousDirs).filter((dir) => !previousParent || !sameDir(dir, previousParent, platform));
    return {
        localRuntimeDataParentDir: previousParent,
        localRuntimePreviousDataParentDirs: historical,
        localRuntimeDataDirPendingVerification: undefined,
        localRuntimeDataDirRollbackNotice: notice,
    };
}
/**
 * Runs once at process start, before the configured directory is applied. Restores the
 * previous directory when earlier launches attempted a Runtime start and never got ready.
 *
 * `isConfiguredDirInUse` reports whether this launch's Runtime will actually use the
 * configured directory. When an env override points elsewhere, the launch neither verifies
 * nor rolls back, and the marker is left for a launch that does use the directory.
 */
export function verifyDataDirAtStartup(config, saveConfig, options = {}) {
    const platform = options.platform ?? process.platform;
    const configuredParent = typeof config.localRuntimeDataParentDir === 'string'
        ? config.localRuntimeDataParentDir
        : undefined;
    const noop = () => undefined;
    if (config.localRuntimeDataDirPendingVerification === undefined) {
        return { action: 'none', parentDir: configuredParent, commit: noop };
    }
    const marker = readPendingVerification(config.localRuntimeDataDirPendingVerification);
    if (!marker || !markerMatchesConfig(marker, config, platform)) {
        return {
            action: 'none',
            parentDir: configuredParent,
            commit: () => saveConfig({ localRuntimeDataDirPendingVerification: undefined }),
        };
    }
    if (options.isConfiguredDirInUse && !options.isConfiguredDirInUse(marker.targetParentDir)) {
        return { action: 'none', parentDir: configuredParent, commit: noop };
    }
    if (marker.unreadyLaunches < DATA_DIR_VERIFICATION_MAX_UNREADY_LAUNCHES) {
        return { action: 'pending', parentDir: configuredParent, marker, commit: noop };
    }
    const patch = buildRollbackPatch(marker, { reason: 'not-ready', atMs: options.now ?? Date.now() }, platform);
    return {
        action: 'rolled-back',
        parentDir: patch.localRuntimeDataParentDir,
        commit: () => saveConfig(patch),
    };
}
// A terminal owner conflict means another process holds the directory; that is not
// evidence that the new directory is unusable.
const NON_DIRECTORY_FAILURE_CODES = new Set(['runtime_owner_conflict']);
let deps = null;
/** The marker this process started with; a later relocation writes a different one. */
let watchedMarker = null;
let relaunch = null;
let relaunchPending = false;
let bufferedEvents = [];
let startAttemptCounted = false;
let settled = false;
/** This process wrote a rollback and is relaunching; its notice belongs to the next start. */
let rolledBackInThisProcess = false;
function requestRollbackRelaunch(current) {
    if (!relaunch) {
        // Settings IPC registers the relaunch later in startup; it runs the pending one then.
        relaunchPending = true;
        return;
    }
    relaunchPending = false;
    void relaunch().catch((error) => {
        current.logger.error(`[DataDirGuard] Relaunch after data directory rollback failed: ${error instanceof Error ? error.name : 'unknown'}`);
    });
}
function handleEvent(current, event) {
    const platform = current.platform ?? process.platform;
    const marker = readActiveMarker(current.getConfig(), current.saveConfig, platform);
    if (!marker ||
        !watchedMarker ||
        marker.createdAtMs !== watchedMarker.createdAtMs ||
        !sameDir(marker.targetParentDir, watchedMarker.targetParentDir, platform)) {
        settled = true;
        return;
    }
    if (event.kind === 'start-attempt') {
        if (startAttemptCounted)
            return;
        startAttemptCounted = true;
        current.saveConfig({
            localRuntimeDataDirPendingVerification: {
                ...marker,
                unreadyLaunches: marker.unreadyLaunches + 1,
            },
        });
        return;
    }
    if (event.kind === 'ready') {
        settled = true;
        current.saveConfig({ localRuntimeDataDirPendingVerification: undefined });
        current.logger.info(`[DataDirGuard] Runtime ready on relocated data directory; verification cleared (unreadyLaunches=${marker.unreadyLaunches})`);
        return;
    }
    if (event.reasonCode && NON_DIRECTORY_FAILURE_CODES.has(event.reasonCode)) {
        // The start attempt counted above says nothing about the directory either: give it back
        // so a directory held by another client never accumulates into a not-ready rollback.
        // The manager latches on an owner conflict and never forks again in this process, so
        // later start requests must not count either; the next launch verifies afresh.
        settled = true;
        if (startAttemptCounted && marker.unreadyLaunches > 0) {
            current.saveConfig({
                localRuntimeDataDirPendingVerification: {
                    ...marker,
                    unreadyLaunches: marker.unreadyLaunches - 1,
                },
            });
        }
        current.logger.warn(`[DataDirGuard] Runtime terminal failure on relocated data directory ignored (reasonCode=${event.reasonCode})`);
        return;
    }
    settled = true;
    rolledBackInThisProcess = true;
    current.saveConfig(buildRollbackPatch(marker, {
        reason: 'runtime-failed',
        ...(event.reasonCode ? { reasonCode: event.reasonCode } : {}),
        atMs: current.now?.() ?? Date.now(),
    }, platform));
    current.logger.error(`[DataDirGuard] Runtime failed on relocated data directory; restored previous directory (reasonCode=${event.reasonCode ?? 'unknown'})`);
    requestRollbackRelaunch(current);
}
function dispatch(event) {
    if (settled)
        return;
    if (!deps) {
        // Only the first event of each kind matters; keep the buffer bounded.
        if (!bufferedEvents.some((buffered) => buffered.kind === event.kind)) {
            bufferedEvents.push(event);
        }
        return;
    }
    try {
        handleEvent(deps, event);
    }
    catch {
        deps.logger.error('[DataDirGuard] Failed to update data directory verification');
    }
}
/**
 * Called once at process start, after verifyDataDirAtStartup. Only a process that
 * started on a directory awaiting verification watches the Runtime: the process that
 * performs a relocation must not react to the marker it has just written.
 */
export function configureDataDirRelocationGuard(next, startup) {
    deps = next;
    const pending = bufferedEvents;
    bufferedEvents = [];
    if (startup.action !== 'pending' || !startup.marker) {
        settled = true;
        return;
    }
    watchedMarker = {
        targetParentDir: startup.marker.targetParentDir,
        createdAtMs: startup.marker.createdAtMs,
    };
    for (const event of pending)
        dispatch(event);
}
/** Registered once the quit coordinator is available. Runs a rollback relaunch left pending. */
export function setDataDirRelocationGuardRelaunch(next) {
    relaunch = next;
    if (relaunchPending && deps)
        requestRollbackRelaunch(deps);
}
export function notifyDataDirRuntimeStartAttempt() {
    // Called on every Runtime request path; only the first attempt is counted.
    if (settled || startAttemptCounted)
        return;
    if (!deps && bufferedEvents.some((event) => event.kind === 'start-attempt'))
        return;
    dispatch({ kind: 'start-attempt' });
}
export function notifyDataDirRuntimeReady() {
    dispatch({ kind: 'ready' });
}
export function notifyDataDirRuntimeTerminalFailure(reasonCode) {
    dispatch({ kind: 'terminal-failure', ...(reasonCode ? { reasonCode } : {}) });
}
/** Returns and clears the notice left by a rollback, so it is shown once. */
export function takeDataDirRollbackNotice(config, saveConfig) {
    if (config.localRuntimeDataDirRollbackNotice === undefined || rolledBackInThisProcess) {
        return null;
    }
    saveConfig({ localRuntimeDataDirRollbackNotice: undefined });
    return readRollbackNotice(config.localRuntimeDataDirRollbackNotice);
}
/** Test-only. */
export function resetDataDirRelocationGuardForTests() {
    deps = null;
    watchedMarker = null;
    relaunch = null;
    relaunchPending = false;
    bufferedEvents = [];
    startAttemptCounted = false;
    settled = false;
    rolledBackInThisProcess = false;
}
