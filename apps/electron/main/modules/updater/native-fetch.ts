import { autoUpdater } from "electron";
import { getCategoryLogger } from "../../utils/logger";
import { enqueueElectronObservabilityEvent } from "../observability/outbox";
import { isNativeUpdateReady } from "./state";
const logger = getCategoryLogger('update');
const NATIVE_FETCH_WATCHDOG_MS = 30000;
let nativeFetchInFlight = null;
/** 原生安装包仍在处理中时，不替换它正在读取的下载文件。 */
export function isNativeUpdaterFetchInFlight() {
    return nativeFetchInFlight !== null;
}
function observeNativeUpdaterFetch(payload) {
    try {
        enqueueElectronObservabilityEvent('updater.native_fetch', payload);
    }
    catch {
        // Observability must remain fail-open even if an injected/custom outbox fails.
    }
}
function elapsedMs(startedAt) {
    return Math.max(0, Date.now() - startedAt);
}
function unrefTimer(timer) {
    const unref = timer.unref;
    if (typeof unref === 'function')
        unref.call(timer);
}
/**
 * Start or join the one Squirrel.Mac native fetch for the pending update.
 *
 * Electron's native autoUpdater API is event-based and returns void. Calling
 * checkForUpdates() again while the first attempt is active starts another
 * download, so every production entry point must share this single-flight.
 */
export function triggerNativeUpdaterFetch(source) {
    if (process.platform !== 'darwin') {
        return { success: true, started: false };
    }
    if (isNativeUpdateReady()) {
        observeNativeUpdaterFetch({
            stage: 'decision',
            native_fetch_source: source,
            decision: 'ready_skip',
        });
        return { success: true, started: false };
    }
    if (nativeFetchInFlight) {
        logger.info('[Updater] Squirrel.Mac 原生更新拉取已在进行，复用当前任务');
        observeNativeUpdaterFetch({
            stage: 'decision',
            native_fetch_source: source,
            decision: 'reused',
        });
        return { success: true, started: false };
    }
    // Publish the claim before calling Electron: native events may fire
    // synchronously in tests or platform adapters.
    const attempt = {
        source,
        startedAt: Date.now(),
        watchdog: null,
    };
    nativeFetchInFlight = attempt;
    attempt.watchdog = setTimeout(() => {
        if (nativeFetchInFlight !== attempt)
            return;
        observeNativeUpdaterFetch({
            stage: 'watchdog',
            native_fetch_source: attempt.source,
            outcome: 'pending',
            duration_ms: elapsedMs(attempt.startedAt),
        });
    }, NATIVE_FETCH_WATCHDOG_MS);
    unrefTimer(attempt.watchdog);
    observeNativeUpdaterFetch({
        stage: 'decision',
        native_fetch_source: source,
        decision: 'started',
    });
    try {
        autoUpdater.checkForUpdates();
        return { success: true, started: true };
    }
    catch (error) {
        if (nativeFetchInFlight === attempt) {
            nativeFetchInFlight = null;
            if (attempt.watchdog !== null)
                clearTimeout(attempt.watchdog);
        }
        observeNativeUpdaterFetch({
            stage: 'settled',
            native_fetch_source: source,
            outcome: 'sync_error',
            duration_ms: elapsedMs(attempt.startedAt),
        });
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[Updater] Squirrel.Mac 原生更新拉取失败: ${msg}`);
        return { success: false, error: msg };
    }
}
/** Release the active claim after a terminal native updater event. */
export function settleNativeUpdaterFetch(outcome) {
    const attempt = nativeFetchInFlight;
    if (!attempt)
        return;
    nativeFetchInFlight = null;
    if (attempt.watchdog !== null)
        clearTimeout(attempt.watchdog);
    observeNativeUpdaterFetch({
        stage: 'settled',
        native_fetch_source: attempt.source,
        outcome,
        duration_ms: elapsedMs(attempt.startedAt),
    });
}
