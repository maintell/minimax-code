import { getConfig } from "@mavis/config";
import { requestUtilityMiniApp, isUtilityRuntimeReady } from "../local-runtime/utility";
import { destroyManagedMiniAppTabs, sleepManagedMiniAppTabs, getEmbeddedBrowserManager, miniAppTabClosedDuringRestoreError } from "./embedded-browser-manager";
import { parseMiniAppLoopbackOrigin } from "./miniapp-loopback-origin";
// The surface request serially includes a Utility round trip; keep this well under the
// broker's overall request deadline so a slow credential read never blocks an open or refresh.
const REFRESH_CREDENTIAL_TIMEOUT_MS = 5000;
const pendingCloseStops = new Map();
const pendingStops = new Map();
const pendingLaunches = new Map();
/** Closes every managed tab for one plugin without instantiating the Browser owner. */
export async function closeManagedMiniAppSurface(input, dependencies = {
    destroyTabs: destroyManagedMiniAppTabs,
}) {
    assertGenerationCurrent(input.isGenerationCurrent);
    cancelPendingLaunches(input.pluginId);
    dependencies.destroyTabs(input.pluginId);
}
/**
 * Runtime memory coordinator asks Main to destroy hidden pages of one Mini App (one session's
 * page, or all of them). A refusal changes nothing. The Host UI hears about pages that slept;
 * for a whole Mini App with `notify` (sent again after its backend stopped) it hears even when
 * no page was left to sleep.
 */
export async function sleepManagedMiniAppSurface(input, dependencies) {
    assertGenerationCurrent(input.isGenerationCurrent);
    const result = (dependencies.sleepTabs ?? sleepManagedMiniAppTabs)({
        pluginId: input.pluginId,
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    });
    if (!result.slept)
        return result;
    const tellsUser = input.sessionId === undefined && input.notify;
    if (result.sleptPages === 0 && !tellsUser)
        return { slept: true };
    try {
        dependencies.notifySlept({
            pluginId: input.pluginId,
            ...(result.displayName !== undefined ? { displayName: result.displayName } : {}),
            reason: input.reason,
            unit: input.sessionId !== undefined ? 'page' : 'app',
            notify: input.notify,
        });
    }
    catch {
        // The pages already slept; a lost notice must not report the sleep as failed.
    }
    return { slept: true };
}
/** Page teardown is synchronous; runtime cleanup remains owned and observed in Main. */
export function closeManagedMiniAppPages(pluginId, dependencies) {
    cancelPendingLaunches(pluginId);
    const closedTabIds = dependencies.destroyTabs(pluginId);
    if (!pendingCloseStops.has(pluginId)) {
        const stopped = runManagedMiniAppStop(pluginId, async () => {
            try {
                await dependencies.stopRuntime();
            }
            catch (error) {
                try {
                    dependencies.onStopFailure(error);
                }
                catch {
                    // A diagnostic failure cannot leave detached cleanup unobserved.
                }
            }
        });
        pendingCloseStops.set(pluginId, stopped);
        void stopped.then(() => {
            if (pendingCloseStops.get(pluginId) === stopped)
                pendingCloseStops.delete(pluginId);
        });
    }
    return closedTabIds;
}
/** Keeps launches behind every Main stop, including any destructive page cleanup it owns. */
export function runManagedMiniAppStop(pluginId, stop) {
    const result = Promise.resolve().then(stop);
    const settled = result.then(() => undefined, () => undefined);
    const stops = pendingStops.get(pluginId) ?? new Set();
    stops.add(settled);
    pendingStops.set(pluginId, stops);
    void settled.then(() => {
        stops.delete(settled);
        if (stops.size === 0 && pendingStops.get(pluginId) === stops)
            pendingStops.delete(pluginId);
    });
    return result;
}
/** A new launch waits for prior stop cleanup; another close revokes the whole launch. */
export async function runManagedMiniAppLaunch(pluginId, launch, callerSignal) {
    const controller = new AbortController();
    const signal = callerSignal
        ? AbortSignal.any([callerSignal, controller.signal])
        : controller.signal;
    const launches = pendingLaunches.get(pluginId) ?? new Set();
    launches.add(controller);
    pendingLaunches.set(pluginId, launches);
    try {
        signal.throwIfAborted();
        while (pendingStops.get(pluginId)?.size) {
            const stopping = Promise.all(pendingStops.get(pluginId) ?? []).then(() => undefined);
            await waitForCloseStop(stopping, signal);
            signal.throwIfAborted();
        }
        signal.throwIfAborted();
        const result = await launch(signal);
        // Unlike caller cancellation after commit, a close has already removed this page.
        controller.signal.throwIfAborted();
        return result;
    }
    finally {
        launches.delete(controller);
        if (launches.size === 0 && pendingLaunches.get(pluginId) === launches) {
            pendingLaunches.delete(pluginId);
        }
    }
}
function cancelPendingLaunches(pluginId) {
    const launches = pendingLaunches.get(pluginId);
    pendingLaunches.delete(pluginId);
    for (const controller of launches ?? []) {
        controller.abort(Object.assign(new Error('Mini App page was closed'), { code: 'stale_surface' }));
    }
}
async function waitForCloseStop(stopping, signal) {
    let onAbort;
    try {
        await Promise.race([
            stopping,
            new Promise((_resolve, reject) => {
                onAbort = () => reject(signal.reason);
                signal.addEventListener('abort', onAbort, { once: true });
                if (signal.aborted)
                    onAbort();
            }),
        ]);
    }
    finally {
        if (onAbort)
            signal.removeEventListener('abort', onAbort);
    }
}
/**
 * Reads the credential of the run serving `pluginId` without starting anything. Any failure
 * (not running, Utility unavailable, or a timed-out/rejected request) reports "not running",
 * which the open and refresh paths treat as their existing fallback: refresh keeps the tab's
 * current credential and open proceeds with the launch it already has in hand.
 */
export async function readRunningMiniAppCredential(pluginId, dependencies = { requestLaunch: requestUtilityMiniApp, isUtilityReady: isUtilityRuntimeReady }) {
    const isReady = dependencies.isUtilityReady ?? isUtilityRuntimeReady;
    if (!isReady())
        return undefined;
    try {
        const result = await dependencies.requestLaunch('credential', pluginId, AbortSignal.timeout(REFRESH_CREDENTIAL_TIMEOUT_MS));
        if (!('credential' in result))
            return undefined;
        return {
            origin: result.credential.origin,
            runId: result.credential.runId,
            loopbackToken: result.credential.loopbackToken,
        };
    }
    catch {
        return undefined;
    }
}
/** Resolves private launch coordinates in Main and commits the managed native Browser tab. */
export async function openManagedMiniAppSurface(input, dependencies = {
    isEnabled: () => getConfig().beta.filePanelBrowser === true,
    requestLaunch: requestUtilityMiniApp,
    openTab: (openInput) => getEmbeddedBrowserManager().openMiniAppTab(openInput),
    sleepingTab: (sessionId, pluginId) => getEmbeddedBrowserManager().sleepingMiniAppTab(sessionId, pluginId),
    isUtilityReady: isUtilityRuntimeReady,
}) {
    if (!dependencies.isEnabled()) {
        throw Object.assign(new Error('Mini App surface is unavailable'), {
            code: 'runtime_unavailable',
        });
    }
    assertGenerationCurrent(input.isGenerationCurrent);
    input.signal?.throwIfAborted();
    if (input.path !== undefined &&
        (typeof input.path !== 'string' ||
            input.path.length > 4096 ||
            !input.path.startsWith('/') ||
            input.path.startsWith('//') ||
            /[\\\u0000-\u0020\u007f#]/u.test(input.path) ||
            /%(?![0-9a-f]{2})/iu.test(input.path))) {
        throw Object.assign(new Error('Invalid Mini App open path'), { code: 'invalid_request' });
    }
    // What this open is about is settled here, before anything is awaited: the sleeping tab it
    // binds to (if any) is read once, and its closing cancels the open from this point on.
    const sleeping = dependencies.sleepingTab?.(input.sessionId, input.pluginId);
    if (input.restoreTabId !== undefined && sleeping?.tabId !== input.restoreTabId) {
        throw miniAppTabClosedDuringRestoreError();
    }
    const bound = input.restoreTabId !== undefined ? sleeping : undefined;
    const restoreSignal = bound && input.signal
        ? AbortSignal.any([input.signal, bound.signal])
        : (bound?.signal ?? input.signal);
    return runManagedMiniAppLaunch(input.pluginId, async (signal) => {
        const attemptOpen = async () => {
            const result = await dependencies.requestLaunch('open', input.pluginId, signal);
            signal.throwIfAborted();
            assertGenerationCurrent(input.isGenerationCurrent);
            if (!('launch' in result)) {
                throw Object.assign(new Error('Mini App launch was not returned'), {
                    code: 'start_failed',
                });
            }
            // An @ of a sleeping App only needed its backend up: the tab stays asleep until the user
            // opens it. Decided on the record read above, not on whatever is left after the launch.
            if (input.keepSleepingTab && sleeping)
                return sleeping.summary;
            // Opening the native tab is the commit point. Once it succeeds the visible
            // side effect is authoritative even if cancellation races with completion.
            return dependencies.openTab({
                sessionId: input.sessionId,
                miniApp: result.miniApp,
                url: resolveMiniAppUrl(result.launch.origin, input.path ?? result.launch.surfacePath),
                preserveCurrentUrl: input.path === undefined,
                ...(input.restoreTabId !== undefined ? { restoreTabId: input.restoreTabId } : {}),
                runId: result.launch.runId,
                loopbackToken: result.launch.loopbackToken,
                ...(result.launch.window ? { window: result.launch.window } : {}),
                signal,
                ...(input.isGenerationCurrent ? { isGenerationCurrent: input.isGenerationCurrent } : {}),
                readCredential: () => readRunningMiniAppCredential(input.pluginId, dependencies),
            });
        };
        // Every caller of this shared entry — manual IPC and Agent open alike — is protected against
        // dequeuing behind a plugin restart: the Browser manager rejects a stale launch instead of
        // writing its token anywhere, and this retries once with a fresh broker launch. A second stale
        // run in a row means Utility keeps restarting, which callers already understand as busy.
        // `stale_launch` is internal only and must never escape this function.
        try {
            return await attemptOpen();
        }
        catch (error) {
            signal.throwIfAborted();
            if (!isStaleMiniAppLaunchError(error))
                throw error;
            try {
                return await attemptOpen();
            }
            catch (retryError) {
                signal.throwIfAborted();
                if (!isStaleMiniAppLaunchError(retryError))
                    throw retryError;
                throw Object.assign(new Error('Mini App is restarting'), {
                    code: 'busy',
                    busyReason: 'operation_busy',
                });
            }
        }
    }, restoreSignal);
}
function isStaleMiniAppLaunchError(error) {
    return (error !== null &&
        typeof error === 'object' &&
        error.code === 'stale_launch');
}
function resolveMiniAppUrl(origin, surfacePath) {
    const parsedOrigin = parseMiniAppLoopbackOrigin(origin);
    if (!parsedOrigin) {
        throw new Error('Invalid Mini App origin');
    }
    if (!surfacePath.startsWith('/') || surfacePath.startsWith('//')) {
        throw new Error('Invalid Mini App surface path');
    }
    const resolved = new URL(surfacePath, `${origin}/`);
    if (resolved.origin !== parsedOrigin.origin)
        throw new Error('Invalid Mini App surface path');
    return resolved.href;
}
function assertGenerationCurrent(isGenerationCurrent) {
    if (!isGenerationCurrent)
        return;
    let current = false;
    try {
        current = isGenerationCurrent();
    }
    catch {
        // A broken generation probe cannot authorize a native surface commit.
    }
    if (!current) {
        throw Object.assign(new Error('Mini App Utility generation is unavailable'), {
            code: 'runtime_unavailable',
        });
    }
}
