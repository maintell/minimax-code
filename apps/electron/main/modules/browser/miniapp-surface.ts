import { getConfig } from "@mavis/config";
import { requestUtilityMiniApp, isUtilityRuntimeReady } from "../local-runtime/utility";
import { destroyManagedMiniAppTabs, getEmbeddedBrowserManager } from "./embedded-browser-manager";
import { parseMiniAppLoopbackOrigin } from "./miniapp-loopback-origin";
// The surface request serially includes a Utility round trip; keep this well under the
// broker's overall request deadline so a slow credential read never blocks an open or refresh.
const REFRESH_CREDENTIAL_TIMEOUT_MS = 5000;
/** Closes every managed tab for one plugin without instantiating the Browser owner. */
export async function closeManagedMiniAppSurface(input, dependencies = {
    destroyTabs: destroyManagedMiniAppTabs,
}) {
    assertGenerationCurrent(input.isGenerationCurrent);
    dependencies.destroyTabs(input.pluginId);
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
    const attemptOpen = async () => {
        const result = await dependencies.requestLaunch('open', input.pluginId, input.signal);
        input.signal?.throwIfAborted();
        assertGenerationCurrent(input.isGenerationCurrent);
        if (!('launch' in result)) {
            throw Object.assign(new Error('Mini App launch was not returned'), { code: 'start_failed' });
        }
        // Opening the native tab is the commit point. Once it succeeds the visible
        // side effect is authoritative even if cancellation races with completion.
        return dependencies.openTab({
            sessionId: input.sessionId,
            miniApp: result.miniApp,
            url: resolveMiniAppUrl(result.launch.origin, input.path ?? result.launch.surfacePath),
            preserveCurrentUrl: input.path === undefined,
            runId: result.launch.runId,
            loopbackToken: result.launch.loopbackToken,
            ...(result.launch.window ? { window: result.launch.window } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
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
        if (!isStaleMiniAppLaunchError(error))
            throw error;
        try {
            return await attemptOpen();
        }
        catch (retryError) {
            if (!isStaleMiniAppLaunchError(retryError))
                throw retryError;
            throw Object.assign(new Error('Mini App is restarting'), {
                code: 'busy',
                busyReason: 'operation_busy',
            });
        }
    }
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
