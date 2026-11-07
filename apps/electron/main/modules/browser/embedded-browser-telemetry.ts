import * as observabilityOutbox from "../observability/outbox";
import { browserTelemetry } from "./browser-telemetry-runtime.js";
import { browserUrlScheme, browserUrlHost } from "./browser-telemetry.js";
const tabStates = new WeakMap();
function guard(run) {
    try {
        run();
    }
    catch {
        // Telemetry is observational only.
    }
}
export function tabTelemetryContext(tab) {
    return {
        rendererBackend: tab.backendSelection?.rendererBackend ?? 'web-contents-view',
        surfaceKind: tab.miniApp ? 'miniapp' : 'browser',
        presentation: tab.detachedWindow
            ? 'detached'
            : tab.bounds.x < 0 || tab.bounds.y < 0
                ? 'hidden'
                : 'panel',
    };
}
function tabKey(tab) {
    return `tab:${tab.tabId}`;
}
export function onTelemetryTabCreated(tab, timing) {
    guard(() => {
        const now = Date.now();
        tabStates.set(tab, {
            openedAt: timing.requestedAt,
            createMs: Math.max(0, now - timing.requestedAt),
            coldWaitMs: timing.coldWaitMs,
            ...(timing.attachMs !== undefined ? { attachMs: timing.attachMs } : {}),
            restored: timing.restored,
            firstLoadStartedAt: now,
            firstLoadReported: false,
        });
        browserTelemetry.tabOpened(tab.backendSelection?.rendererBackend);
    });
}
/** A tab whose page could not be created never reaches onTelemetryTabCreated. */
export function onTelemetryTabCreateFailed(context, timing) {
    guard(() => {
        browserTelemetry.report('browser.tab_open', {
            rendererBackend: context.rendererBackend,
            surfaceKind: context.surfaceKind,
            presentation: 'panel',
        }, {
            result: 'create_failed',
            restored: timing.restored,
            create_ms: Math.max(0, Date.now() - timing.requestedAt),
            ...(timing.coldWaitMs ? { cold_wait_ms: timing.coldWaitMs } : {}),
        }, { cooldownKey: `create_failed:${context.rendererBackend}`, kind: 'error' });
    });
}
function reportTabOpen(tab, result) {
    const state = tabStates.get(tab);
    if (!state || state.firstLoadReported)
        return;
    state.firstLoadReported = true;
    browserTelemetry.report('browser.tab_open', tabTelemetryContext(tab), {
        result,
        url_scheme: browserUrlScheme(tab.url),
        restored: state.restored,
        ...(state.createMs !== undefined ? { create_ms: state.createMs } : {}),
        ...(state.coldWaitMs ? { cold_wait_ms: state.coldWaitMs } : {}),
        ...(state.attachMs !== undefined ? { attach_ms: state.attachMs } : {}),
        ...(result === 'loaded' && state.firstLoadStartedAt !== undefined
            ? { first_load_ms: Math.max(0, Date.now() - state.firstLoadStartedAt) }
            : {}),
    }, { host: browserUrlHost(tab.url) });
}
export function onTelemetryTabLoaded(tab) {
    guard(() => {
        // about:blank bootstraps are not the user's first page.
        if (browserUrlScheme(tab.url) === 'about')
            return;
        reportTabOpen(tab, 'loaded');
    });
}
export function onTelemetryLoadFailed(tab, errorCode, url) {
    guard(() => {
        const state = tabStates.get(tab);
        const initial = Boolean(state && !state.firstLoadReported);
        browserTelemetry.count(tab.backendSelection?.rendererBackend, 'load_failed_count');
        browserTelemetry.report('browser.load_failed', tabTelemetryContext(tab), { error_code: errorCode, url_scheme: browserUrlScheme(url), is_initial_load: initial }, { cooldownKey: `${tabKey(tab)}:${errorCode}`, kind: 'error', host: browserUrlHost(url) });
        if (initial)
            reportTabOpen(tab, 'failed');
    });
}
export function onTelemetryTabDestroyed(tab, preserveLogicalTab) {
    guard(() => {
        reportTabOpen(tab, 'closed_before_load');
        if (!preserveLogicalTab)
            browserTelemetry.tabClosed(tab.backendSelection?.rendererBackend);
    });
}
export function onTelemetryTabSuspended(tab) {
    guard(() => browserTelemetry.count(tab.backendSelection?.rendererBackend, 'suspend_count'));
}
export function onTelemetryTabResumed(tab) {
    guard(() => browserTelemetry.count(tab.backendSelection?.rendererBackend, 'resume_count'));
}
export function onTelemetryDetach(tab) {
    guard(() => browserTelemetry.count(tab.backendSelection?.rendererBackend, 'detach_count'));
}
export function onTelemetryPageCrash(tab, details, agentOperationActive) {
    guard(() => {
        const reason = details?.reason ?? 'crashed';
        // Pages torn down by app quit are not crashes. Optional so partial outbox mocks stay usable.
        if (reason === 'clean-exit' || observabilityOutbox.isElectronObservabilityShuttingDown?.())
            return;
        const state = tabStates.get(tab);
        browserTelemetry.count(tab.backendSelection?.rendererBackend, 'crash_count');
        browserTelemetry.sampleResources('page-crash');
        browserTelemetry.report('browser.page_crash', tabTelemetryContext(tab), {
            reason,
            ...(typeof details?.exitCode === 'number' ? { exit_code: details.exitCode } : {}),
            url_scheme: browserUrlScheme(tab.url),
            ...(state ? { page_age_ms: Math.max(0, Date.now() - state.openedAt) } : {}),
            was_visible: tab.bounds.x >= 0 && tab.bounds.y >= 0,
            agent_operation_active: agentOperationActive,
        }, { cooldownKey: tabKey(tab), kind: 'error', host: browserUrlHost(tab.url) });
    });
}
export function bindTelemetryResponsiveness(tab, addListener, agentOperationActive) {
    guard(() => {
        addListener('unresponsive', () => guard(() => {
            const state = tabStates.get(tab);
            if (state)
                state.unresponsiveAt = Date.now();
            browserTelemetry.count(tab.backendSelection?.rendererBackend, 'unresponsive_count');
            browserTelemetry.sampleResources('page-unresponsive');
            browserTelemetry.report('browser.page_unresponsive', tabTelemetryContext(tab), {
                url_scheme: browserUrlScheme(tab.url),
                was_visible: tab.bounds.x >= 0 && tab.bounds.y >= 0,
                agent_operation_active: agentOperationActive(),
            }, { cooldownKey: tabKey(tab), kind: 'error', host: browserUrlHost(tab.url) });
        }));
        addListener('responsive', () => guard(() => {
            const state = tabStates.get(tab);
            if (!state?.unresponsiveAt)
                return;
            const duration = Math.max(0, Date.now() - state.unresponsiveAt);
            state.unresponsiveAt = undefined;
            browserTelemetry.count(tab.backendSelection?.rendererBackend, 'unresponsive_total_ms', duration);
            browserTelemetry.report('browser.page_recovered', tabTelemetryContext(tab), { unresponsive_ms: duration }, { cooldownKey: tabKey(tab), host: browserUrlHost(tab.url) });
        }));
    });
}
export function onTelemetryGuestRebuild(tab, trigger, result, durationMs) {
    guard(() => {
        const backend = tab.backendSelection?.rendererBackend;
        browserTelemetry.count(backend, 'rebuild_count');
        if (result === 'failed')
            browserTelemetry.count(backend, 'rebuild_failed_count');
        browserTelemetry.report('browser.guest_rebuild', tabTelemetryContext(tab), {
            trigger,
            result,
            duration_ms: durationMs,
            guest_generation: tab.guestGeneration ?? 1,
        }, {
            cooldownKey: result === 'recovered' ? undefined : tabKey(tab),
            kind: result === 'failed' ? 'error' : 'action',
            host: browserUrlHost(tab.url),
        });
    });
}
export function onTelemetryAgentOperation(tab, tool, durationMs, ok) {
    guard(() => browserTelemetry.agentOperation(tab?.backendSelection?.rendererBackend, tool, durationMs, ok, Boolean(tab && (tab.bounds.x < 0 || tab.bounds.y < 0))));
}
export function recordTelemetryCompatibility(backend, action) {
    guard(() => {
        if (action === 'nativeResizeRelay')
            browserTelemetry.count(backend, 'resize_relay_count');
        else if (action === 'overlayCapture')
            browserTelemetry.count(backend, 'overlay_capture_count');
        else if (action === 'nativeParking')
            browserTelemetry.count(backend, 'parking_count');
    });
}
