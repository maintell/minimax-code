const STARTUP_SUMMARY_EVENT = 'app.startup_performance_summary';
const RUNTIME_READY_SUMMARY_EVENT = 'app.startup_runtime_ready_summary';
const MAX_STARTUP_DURATION_MS = 10 * 60 * 1000;
const RENDERER_MILESTONES = new Set([
    'preload_ready',
    'renderer_entry',
    'electron_app_render_started',
    'electron_app_content_render_started',
    'route_modules_loaded',
    'mavis_content_render_started',
    'runtime_transport_bootstrap_settled',
    'mavis_layout_render_started',
    'mavis_layout_commit',
    'mavis_page_render_started',
    'mavis_home_render_started',
    'mavis_home_commit',
    'chat_panel_render_started',
    'chat_panel_commit',
    'react_commit',
    'surface_committed',
    'first_content_visible',
]);
const MAIN_MILESTONE_PREVIOUS = {
    app_ready: 'main_entry',
    ipc_ready: 'app_ready',
    auth_bootstrap_ready: 'ipc_ready',
    runtime_fetch_devtools_ready: 'auth_bootstrap_ready',
    initial_window_creation_started: 'auth_bootstrap_ready',
    browser_window_created: 'initial_window_creation_started',
    next_server_ready: 'browser_window_created',
    load_url_started: 'browser_window_created',
};
function isFiniteTimestamp(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function isStartupSurface(value) {
    return value === 'login' || value === 'app';
}
function isRendererMilestone(value) {
    return (typeof value === 'string' && RENDERER_MILESTONES.has(value));
}
function duration(start, end) {
    return Math.round((end - start) * 1000) / 1000;
}
export function resolveElectronStartupOrigin(input) {
    const creationTime = input.processCreationTimeMs;
    if (isFiniteTimestamp(creationTime) &&
        creationTime <= input.nowEpochMs &&
        input.nowEpochMs - creationTime <= MAX_STARTUP_DURATION_MS) {
        return { timestampEpochMs: creationTime, source: 'process_creation' };
    }
    const timeOrigin = isFiniteTimestamp(input.performanceTimeOriginMs)
        ? input.performanceTimeOriginMs
        : input.nowEpochMs;
    return { timestampEpochMs: timeOrigin, source: 'main_time_origin' };
}
export function createElectronStartupPerformanceTracker(options) {
    let initialSurface;
    let rendererId;
    let completed = false;
    let firstRuntimeReadyAt;
    let runtimeReadyReported = false;
    const milestones = new Map();
    milestones.set('process_created', options.origin.timestampEpochMs);
    const tryEnqueueRuntimeReadySummary = () => {
        if (runtimeReadyReported || initialSurface !== 'app' || firstRuntimeReadyAt === undefined)
            return;
        // Independent of the first-screen completion flag: migrations can finish
        // after the renderer has already submitted its startup summary.
        runtimeReadyReported = true;
        try {
            options.enqueue(RUNTIME_READY_SUMMARY_EVENT, {
                startup_to_runtime_ready_ms: duration(options.origin.timestampEpochMs, firstRuntimeReadyAt),
                start_source: options.origin.source,
            });
        }
        catch {
            // Observability must never affect startup or the existing first-screen markers.
        }
    };
    const recordOrderedMilestone = (milestone, timestampEpochMs, previousMilestone) => {
        if (completed || milestones.has(milestone) || !isFiniteTimestamp(timestampEpochMs)) {
            return false;
        }
        const previousTimestamp = milestones.get(previousMilestone);
        if (previousTimestamp === undefined ||
            timestampEpochMs < previousTimestamp ||
            timestampEpochMs - options.origin.timestampEpochMs > MAX_STARTUP_DURATION_MS) {
            return false;
        }
        milestones.set(milestone, timestampEpochMs);
        return true;
    };
    const tryEnqueueSummary = () => {
        if (completed || !initialSurface)
            return;
        const processCreated = milestones.get('process_created');
        const mainEntry = milestones.get('main_entry');
        const preloadReady = milestones.get('preload_ready');
        const rendererEntry = milestones.get('renderer_entry');
        const electronAppRenderStarted = milestones.get('electron_app_render_started');
        const electronAppContentRenderStarted = milestones.get('electron_app_content_render_started');
        const routeModulesLoaded = milestones.get('route_modules_loaded');
        const mavisContentRenderStarted = milestones.get('mavis_content_render_started');
        const runtimeTransportBootstrapSettled = milestones.get('runtime_transport_bootstrap_settled');
        const mavisLayoutRenderStarted = milestones.get('mavis_layout_render_started');
        const mavisLayoutCommit = milestones.get('mavis_layout_commit');
        const mavisPageRenderStarted = milestones.get('mavis_page_render_started');
        const mavisHomeRenderStarted = milestones.get('mavis_home_render_started');
        const mavisHomeCommit = milestones.get('mavis_home_commit');
        const chatPanelRenderStarted = milestones.get('chat_panel_render_started');
        const chatPanelCommit = milestones.get('chat_panel_commit');
        const reactCommit = milestones.get('react_commit');
        const appReady = milestones.get('app_ready');
        const ipcReady = milestones.get('ipc_ready');
        const authBootstrapReady = milestones.get('auth_bootstrap_ready');
        const runtimeFetchDevtoolsReady = milestones.get('runtime_fetch_devtools_ready');
        const initialWindowCreationStarted = milestones.get('initial_window_creation_started');
        const browserWindowCreated = milestones.get('browser_window_created');
        const nextServerReady = milestones.get('next_server_ready');
        const loadUrlStarted = milestones.get('load_url_started');
        const surfaceCommitted = milestones.get('surface_committed');
        const firstContentVisible = milestones.get('first_content_visible');
        if (processCreated === undefined ||
            mainEntry === undefined ||
            preloadReady === undefined ||
            rendererEntry === undefined ||
            surfaceCommitted === undefined ||
            firstContentVisible === undefined) {
            return;
        }
        completed = true;
        const summary = {
            initial_surface: initialSurface,
            start_source: options.origin.source,
            startup_duration_ms: duration(processCreated, firstContentVisible),
            process_to_main_ms: duration(processCreated, mainEntry),
            main_to_preload_ms: duration(mainEntry, preloadReady),
            preload_to_renderer_ms: duration(preloadReady, rendererEntry),
            renderer_to_surface_ms: duration(rendererEntry, surfaceCommitted),
            surface_to_visible_ms: duration(surfaceCommitted, firstContentVisible),
        };
        const addDuration = (key, start, end) => {
            if (start !== undefined && end !== undefined)
                summary[key] = duration(start, end);
        };
        addDuration('preload_to_route_modules_loaded_ms', preloadReady, routeModulesLoaded);
        addDuration('renderer_to_electron_app_render_started_ms', rendererEntry, electronAppRenderStarted);
        addDuration('renderer_to_electron_app_content_render_started_ms', rendererEntry, electronAppContentRenderStarted);
        if (runtimeTransportBootstrapSettled !== undefined &&
            electronAppContentRenderStarted !== undefined &&
            electronAppContentRenderStarted >= runtimeTransportBootstrapSettled) {
            addDuration('runtime_transport_bootstrap_settled_to_app_content_render_started_ms', runtimeTransportBootstrapSettled, electronAppContentRenderStarted);
        }
        addDuration('renderer_to_mavis_content_render_started_ms', rendererEntry, mavisContentRenderStarted);
        addDuration('mavis_content_render_to_layout_render_started_ms', mavisContentRenderStarted, mavisLayoutRenderStarted);
        addDuration('renderer_to_runtime_transport_bootstrap_settled_ms', rendererEntry, runtimeTransportBootstrapSettled);
        addDuration('renderer_to_react_commit_ms', rendererEntry, reactCommit);
        addDuration('main_to_app_ready_ms', mainEntry, appReady);
        addDuration('app_ready_to_ipc_ready_ms', appReady, ipcReady);
        addDuration('ipc_ready_to_auth_bootstrap_ready_ms', ipcReady, authBootstrapReady);
        addDuration('auth_bootstrap_ready_to_runtime_fetch_devtools_ready_ms', authBootstrapReady, runtimeFetchDevtoolsReady);
        addDuration('auth_bootstrap_ready_to_initial_window_creation_started_ms', authBootstrapReady, initialWindowCreationStarted);
        addDuration('initial_window_creation_started_to_browser_window_created_ms', initialWindowCreationStarted, browserWindowCreated);
        addDuration('browser_window_created_to_next_server_ready_ms', browserWindowCreated, nextServerReady);
        addDuration('browser_window_created_to_load_url_started_ms', browserWindowCreated, loadUrlStarted);
        addDuration('next_server_ready_to_load_url_started_ms', nextServerReady, loadUrlStarted);
        addDuration('load_url_started_to_preload_ready_ms', loadUrlStarted, preloadReady);
        addDuration('renderer_to_mavis_layout_render_started_ms', rendererEntry, mavisLayoutRenderStarted);
        addDuration('mavis_layout_render_to_commit_ms', mavisLayoutRenderStarted, mavisLayoutCommit);
        addDuration('renderer_to_mavis_page_render_started_ms', rendererEntry, mavisPageRenderStarted);
        addDuration('mavis_page_render_to_react_commit_ms', mavisPageRenderStarted, reactCommit);
        addDuration('renderer_to_mavis_home_render_started_ms', rendererEntry, mavisHomeRenderStarted);
        addDuration('mavis_home_render_to_commit_ms', mavisHomeRenderStarted, mavisHomeCommit);
        addDuration('renderer_to_chat_panel_render_started_ms', rendererEntry, chatPanelRenderStarted);
        addDuration('chat_panel_render_to_commit_ms', chatPanelRenderStarted, chatPanelCommit);
        options.enqueue(STARTUP_SUMMARY_EVENT, summary);
        console.log('PERFORMANCE STAGE RECORD:', summary);
    };
    return {
        recordMainEntry(timestampEpochMs) {
            recordOrderedMilestone('main_entry', timestampEpochMs, 'process_created');
        },
        recordMainMilestone(milestone, timestampEpochMs) {
            recordOrderedMilestone(milestone, timestampEpochMs, MAIN_MILESTONE_PREVIOUS[milestone]);
        },
        setInitialSurface(surface) {
            if (!completed && !initialSurface)
                initialSurface = surface;
            tryEnqueueRuntimeReadySummary();
        },
        recordRuntimeReady(timestampEpochMs) {
            if (firstRuntimeReadyAt !== undefined ||
                !isFiniteTimestamp(timestampEpochMs) ||
                timestampEpochMs < options.origin.timestampEpochMs) {
                return;
            }
            // Do not reuse the first-screen ten-minute cutoff for a slow migration.
            if (!Number.isFinite(duration(options.origin.timestampEpochMs, timestampEpochMs)))
                return;
            firstRuntimeReadyAt = timestampEpochMs;
            tryEnqueueRuntimeReadySummary();
        },
        recordRendererMilestone(milestone, timestampEpochMs, senderId, surface) {
            if (completed || !Number.isInteger(senderId) || senderId < 0)
                return;
            if (milestone === 'preload_ready') {
                if (rendererId !== undefined && rendererId !== senderId)
                    return;
                if (recordOrderedMilestone('preload_ready', timestampEpochMs, 'main_entry')) {
                    rendererId = senderId;
                }
                return;
            }
            if (rendererId === undefined || rendererId !== senderId)
                return;
            if ((milestone === 'surface_committed' || milestone === 'first_content_visible') &&
                (!initialSurface || surface !== initialSurface)) {
                return;
            }
            const previousMilestone = milestone === 'renderer_entry'
                ? 'preload_ready'
                : milestone === 'electron_app_render_started'
                    ? 'renderer_entry'
                    : milestone === 'electron_app_content_render_started'
                        ? 'renderer_entry'
                        : milestone === 'mavis_layout_render_started' ||
                            milestone === 'mavis_page_render_started' ||
                            milestone === 'mavis_home_render_started' ||
                            milestone === 'chat_panel_render_started'
                            ? milestone === 'mavis_layout_render_started'
                                ? 'mavis_content_render_started'
                                : 'renderer_entry'
                            : milestone === 'mavis_content_render_started'
                                ? 'electron_app_content_render_started'
                                : milestone === 'route_modules_loaded'
                                    ? 'preload_ready'
                                    : milestone === 'runtime_transport_bootstrap_settled' ||
                                        milestone === 'react_commit'
                                        ? 'renderer_entry'
                                        : milestone === 'mavis_layout_commit'
                                            ? 'mavis_layout_render_started'
                                            : milestone === 'mavis_home_commit'
                                                ? 'mavis_home_render_started'
                                                : milestone === 'chat_panel_commit'
                                                    ? 'chat_panel_render_started'
                                                    : milestone === 'surface_committed'
                                                        ? 'renderer_entry'
                                                        : 'surface_committed';
            if (recordOrderedMilestone(milestone, timestampEpochMs, previousMilestone)) {
                tryEnqueueSummary();
            }
        },
    };
}
function safeProcessCreationTime() {
    try {
        const getCreationTime = process
            .getCreationTime;
        return typeof getCreationTime === 'function' ? getCreationTime.call(process) : null;
    }
    catch {
        return null;
    }
}
function epochNow() {
    return performance.timeOrigin + performance.now();
}
const startupOrigin = resolveElectronStartupOrigin({
    processCreationTimeMs: safeProcessCreationTime(),
    performanceTimeOriginMs: performance.timeOrigin,
    nowEpochMs: epochNow(),
});
let enqueueStartupSummary = () => undefined;
const startupTracker = createElectronStartupPerformanceTracker({
    origin: startupOrigin,
    enqueue: (eventName, payload) => enqueueStartupSummary(eventName, payload),
});
export function recordElectronStartupMainEntry(timestampEpochMs = epochNow()) {
    startupTracker.recordMainEntry(timestampEpochMs);
}
export function recordElectronStartupMainMilestone(milestone, timestampEpochMs = epochNow()) {
    startupTracker.recordMainMilestone(milestone, timestampEpochMs);
}
export function setElectronStartupInitialSurface(surface) {
    startupTracker.setInitialSurface(surface);
}
export function recordElectronStartupRuntimeReady() {
    try {
        startupTracker.recordRuntimeReady(epochNow());
    }
    catch {
        // Clock and telemetry failures must not interrupt the Runtime ready callback.
    }
}
export function setupElectronStartupPerformanceIPC(input) {
    enqueueStartupSummary = input.enqueue;
    input.ipcMain.on(input.channel, (event, payload) => {
        if (!payload || !isRendererMilestone(payload.milestone))
            return;
        const senderId = event.sender?.id;
        if (!Number.isInteger(senderId) || !isFiniteTimestamp(payload.timestampEpochMs))
            return;
        const surface = isStartupSurface(payload.surface) ? payload.surface : undefined;
        startupTracker.recordRendererMilestone(payload.milestone, payload.timestampEpochMs, senderId, surface);
    });
}
