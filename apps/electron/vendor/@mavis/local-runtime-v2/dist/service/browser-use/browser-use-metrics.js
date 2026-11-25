import { incrementMetric, observeMetric, } from '@mavis/shared/local-runtime-logging/metric-registry';
/**
 * Actions that change the current page through input and therefore count as
 * Browser writes. Navigation, scrolling, reads and run_script are excluded.
 */
const BROWSER_WRITE_ACTIONS = {
    click: true,
    click_and_wait_for_navigation: true,
    double_click: true,
    triple_click: true,
    drag: true,
    fill: true,
    type: true,
    paste: true,
    press_key: true,
    check: true,
    uncheck: true,
    select_option: true,
    upload_files: true,
};
/** Turns whose `turn_end` never arrives are dropped beyond this many. */
const MAX_TRACKED_TURNS = 256;
export function createBrowserUseMetrics(client) {
    const tabsOpenedByTurn = new Map();
    const emit = (write) => {
        try {
            write();
        }
        catch {
            // Metrics must not change or mask the Browser action outcome.
        }
    };
    return {
        actionExecuted(observation) {
            // Provider results cross IPC as plain JSON; only these fields are read.
            const result = typeof observation.result === 'object' && observation.result !== null
                ? observation.result
                : undefined;
            const key = turnKey(observation.sessionId, observation.turnId ?? '');
            const opened = (tabsOpenedByTurn.get(key) ?? 0) + (result?.openedInNewTab === true ? 1 : 0);
            // Re-insert so the oldest-first eviction below drops idle Turns first.
            tabsOpenedByTurn.delete(key);
            tabsOpenedByTurn.set(key, opened);
            while (tabsOpenedByTurn.size > MAX_TRACKED_TURNS) {
                const oldest = tabsOpenedByTurn.keys().next().value;
                if (oldest === undefined)
                    break;
                tabsOpenedByTurn.delete(oldest);
            }
            if (observation.action === 'run_script') {
                emit(() => incrementMetric(client, 'browser_run_script_total', 1, {
                    input: runScriptInputUse(result),
                }));
            }
            if (BROWSER_WRITE_ACTIONS[observation.action] === true) {
                emit(() => incrementMetric(client, 'browser_write_action_total', 1, {
                    outcome: writeOutcome(result, observation.errorCode),
                }));
            }
        },
        postActionVisualSettled(observation) {
            emit(() => {
                observeMetric(client, 'browser_post_action_screenshot_duration_ms', wholeMs(observation.waitMs), { outcome: observation.outcome });
                if (observation.outcome !== 'attached' && observation.outcome !== 'deduplicated')
                    return;
                for (const [phase, ms] of postActionVisualPhases(observation)) {
                    observeMetric(client, 'browser_post_action_screenshot_stage_ms', wholeMs(ms), { phase });
                }
            });
        },
        finishTurn(sessionId, turnId) {
            const key = turnKey(sessionId, turnId);
            const opened = tabsOpenedByTurn.get(key);
            if (opened === undefined)
                return;
            tabsOpenedByTurn.delete(key);
            emit(() => observeMetric(client, 'browser_turn_opened_tabs_items', opened, {}));
        },
        clearSession(sessionId) {
            for (const key of tabsOpenedByTurn.keys()) {
                if (key.startsWith(`${sessionId}\0`))
                    tabsOpenedByTurn.delete(key);
            }
        },
        clear() {
            tabsOpenedByTurn.clear();
        },
    };
}
/**
 * `none` when the script called neither keyboard nor mouse. Results without
 * input statistics (the provider threw or refused before the script ran) are
 * `unknown` and stay in the denominator.
 */
function runScriptInputUse(result) {
    if (typeof result?.inputApiCalls === 'number') {
        return result.inputApiCalls > 0 ? 'keyboard_mouse' : 'none';
    }
    const keyEvents = result?.input?.keyEvents;
    const mouseEvents = result?.input?.mouseEvents;
    if (typeof keyEvents !== 'number' || typeof mouseEvents !== 'number')
        return 'unknown';
    return keyEvents + mouseEvents > 0 ? 'keyboard_mouse' : 'none';
}
function writeOutcome(result, errorCode) {
    return result && result.success !== false && errorCode === undefined ? 'ok' : 'error';
}
/**
 * Phases of a returned capture; they add up to `waitMs`. `queue` is the tool's
 * wait before the request plus the provider's render-slot wait. Without a
 * provider split the provider call is reported once as `provider`. `transfer`
 * is the provider call minus its measured steps: IPC both ways plus overhead.
 */
function postActionVisualPhases(observation) {
    const phases = [];
    const timing = observation.providerTiming;
    const providerMs = observation.providerMs;
    if (providerMs === undefined)
        return phases;
    if (timing?.captureMs === undefined) {
        phases.push(['queue', observation.requestMs], ['provider', providerMs]);
    }
    else {
        const queueMs = timing.queueMs ?? 0;
        const encodeMs = timing.encodeMs ?? 0;
        phases.push(['queue', observation.requestMs + queueMs], ['capture', timing.captureMs], ...(timing.encodeMs === undefined ? [] : [['encode', encodeMs]]), ['transfer', providerMs - queueMs - timing.captureMs - encodeMs]);
    }
    if (observation.compressMs !== undefined)
        phases.push(['compress', observation.compressMs]);
    return phases;
}
function wholeMs(value) {
    return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}
function turnKey(sessionId, turnId) {
    return `${sessionId}\0${turnId}`;
}
//# sourceMappingURL=browser-use-metrics.js.map