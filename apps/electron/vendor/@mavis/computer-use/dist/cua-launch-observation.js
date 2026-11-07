/** CG window inventory alone is not evidence that an application reopened its AX window. */
export async function observeLaunchedWindows(input) {
    if (process.platform !== 'darwin')
        return input.result;
    const outer = record(input.result);
    const launched = structured(input.result);
    if (!outer || outer.isError || !launched || !positiveInteger(launched.pid))
        return input.result;
    input.signal.throwIfAborted();
    const pid = launched.pid;
    const started = Date.now();
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(3000)]);
    const observations = [];
    let windows = Array.isArray(launched.windows) ? launched.windows : [];
    let inventoryRefreshed = false;
    let candidateCount = 0;
    let failure;
    try {
        const inventory = structured(await input.runtime.callTool('list_windows', { pid, session: input.request.sessionId }, signal));
        if (!Array.isArray(inventory?.windows))
            throw new Error('window_inventory_unavailable');
        windows = inventory.windows;
        inventoryRefreshed = true;
        // Ordering only limits diagnostic work, never selects a window for input.
        const candidates = windows
            .map(record)
            .filter((window) => Boolean(window &&
            positiveInteger(window.window_id) &&
            (window.pid === undefined || window.pid === pid)))
            .sort((a, b) => Number(b.is_on_screen === true) - Number(a.is_on_screen === true));
        candidateCount = candidates.length;
        for (const window of candidates.slice(0, 6)) {
            signal.throwIfAborted();
            const windowId = window.window_id;
            const state = structured(await input.runtime.callTool('get_window_state', {
                pid,
                window_id: windowId,
                include_screenshot: false,
                session: input.request.sessionId,
            }, signal));
            const elements = Array.isArray(state?.elements) ? state.elements.map(record) : [];
            const rootIndex = elements.findIndex((node) => node?.role === 'AXWindow');
            const root = elements[rootIndex];
            const next = elements[rootIndex + 1];
            const observed = state?.pid === pid &&
                state?.window_id === windowId &&
                !state.degraded_reason &&
                root &&
                typeof root.depth === 'number' &&
                next &&
                typeof next.depth === 'number' &&
                next.depth > root.depth;
            observations.push({
                window_id: windowId,
                status: observed ? 'observed' : state?.degraded_reason ? 'unresolved' : 'unverified',
                element_count: typeof state?.element_count === 'number' ? state.element_count : undefined,
            });
        }
    }
    catch (error) {
        input.signal.throwIfAborted();
        failure = signal.aborted
            ? 'observation_timeout'
            : error instanceof Error
                ? error.name
                : 'observation_failed';
    }
    input.signal.throwIfAborted();
    const observedIds = observations
        .filter((item) => item.status === 'observed')
        .map((item) => item.window_id);
    const launchState = record(launched.launch_state) ?? {};
    const readiness = {
        driver_window_ready: launchState.window_ready,
        window_ready: observedIds.length > 0,
        window_readiness: observedIds.length ? 'observed' : 'unverified',
        observed_window_ids: observedIds,
        document_identity: 'unverified',
    };
    const coverage = {
        candidate_count: candidateCount,
        inspected_count: observations.length,
        complete: inventoryRefreshed && observations.length === candidateCount && !failure,
    };
    input.logger.info('launch_observation', {
        requestId: input.request.requestId,
        sessionId: input.request.sessionId,
        turnId: input.request.turnId,
        generation: input.request.generation,
        pid,
        ...readiness,
        inventoryRefreshed,
        windowCount: windows.length,
        observations,
        coverage,
        failure,
        durationMs: Date.now() - started,
    });
    const result = {
        ...launched,
        windows,
        launch_state: { ...launchState, ...readiness },
        observation: {
            inventory_refreshed: inventoryRefreshed,
            windows: observations,
            coverage,
            failure,
        },
    };
    const structuredJson = JSON.stringify(result);
    return { ...outer, text: structuredJson, structuredJson };
}
function positiveInteger(value) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function structured(value) {
    const outer = record(value);
    if (outer?.isError)
        return undefined;
    const raw = outer?.structuredJson ?? outer?.rawJson;
    try {
        return typeof raw === 'string' ? record(JSON.parse(raw)) : record(raw);
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=cua-launch-observation.js.map