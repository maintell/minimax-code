import { getConfig } from "@mavis/config";
import { requestUtilityMiniApp } from "../local-runtime/utility";
import { destroyManagedMiniAppTabs, getEmbeddedBrowserManager } from "./embedded-browser-manager";
/** Closes every managed tab for one plugin without instantiating the Browser owner. */
export async function closeManagedMiniAppSurface(input, dependencies = {
    destroyTabs: destroyManagedMiniAppTabs,
}) {
    assertGenerationCurrent(input.isGenerationCurrent);
    dependencies.destroyTabs(input.pluginId);
}
/** Resolves private launch coordinates in Main and commits the managed native Browser tab. */
export async function openManagedMiniAppSurface(input, dependencies = {
    isEnabled: () => getConfig().beta.filePanelBrowser === true,
    requestLaunch: requestUtilityMiniApp,
    openTab: (openInput) => getEmbeddedBrowserManager().openMiniAppTab(openInput),
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
    const result = await dependencies.requestLaunch('open', input.pluginId, input.signal);
    input.signal?.throwIfAborted();
    assertGenerationCurrent(input.isGenerationCurrent);
    if (!('launch' in result)) {
        throw Object.assign(new Error('Mini App launch was not returned'), { code: 'start_failed' });
    }
    const tab = await dependencies.openTab({
        sessionId: input.sessionId,
        miniApp: result.miniApp,
        url: resolveMiniAppUrl(result.launch.origin, input.path ?? result.launch.surfacePath),
        runId: result.launch.runId,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.isGenerationCurrent ? { isGenerationCurrent: input.isGenerationCurrent } : {}),
    });
    // Opening the native tab is the commit point. Once it succeeds the visible
    // side effect is authoritative even if cancellation races with completion.
    return tab;
}
function resolveMiniAppUrl(origin, surfacePath) {
    let parsedOrigin;
    try {
        parsedOrigin = new URL(origin);
    }
    catch {
        throw new Error('Invalid Mini App origin');
    }
    if (parsedOrigin.protocol !== 'http:' ||
        (parsedOrigin.hostname !== '127.0.0.1' && parsedOrigin.hostname !== '[::1]') ||
        !parsedOrigin.port ||
        parsedOrigin.origin !== origin) {
        throw new Error('Invalid Mini App origin');
    }
    if (!surfacePath.startsWith('/') || surfacePath.startsWith('//')) {
        throw new Error('Invalid Mini App surface path');
    }
    const resolved = new URL(surfacePath, `${origin}/`);
    if (resolved.origin !== origin)
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
