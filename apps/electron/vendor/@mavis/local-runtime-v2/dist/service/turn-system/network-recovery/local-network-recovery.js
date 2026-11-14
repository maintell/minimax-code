import { overranSystemSleep } from '@mavis/agent-core/pi-turn-runner';
import { createFetchConnectivityProbe, hasRoutableNetworkInterface, networkEndpoint, probeEndpointConnectivity, } from './connectivity-probe.adapter.js';
import { createNetworkOnlineDetector, } from './network-online-detector.js';
import { createSystemResumeDetector } from './system-resume-detector.js';
/** One offline period a model call or a content review waits through before the Turn gives up. */
export const NETWORK_OFFLINE_WAIT_LIMIT_MS = 6 * 60 * 60 * 1_000;
const OFFLINE_POLL_BASE_MS = 1_000;
const OFFLINE_POLL_MAX_MS = 30_000;
/**
 * Process-wide connectivity view for model calls and content reviews. A
 * transport failure is offline when the failing endpoint cannot be reached at
 * all: a HEAD sent through the runtime's own fetch gets no HTTP answer. The device signals
 * are recorded as evidence only, because an upstream outage behind a
 * connected Wi-Fi, a VPN tunnel or a docked adapter leaves them reporting a
 * network. A gateway that opens or refuses a connection is online, so a
 * failing gateway on a working network keeps its bounded retries. A content
 * review asks the review service it calls, or the model gateway reached last
 * when that is unknown, so a gateway on this machine never speaks for it.
 */
export function createLocalNetworkRecovery(options = {}) {
    const probe = options.probe ??
        (options.fetchImpl
            ? createFetchConnectivityProbe(options.fetchImpl)
            : probeEndpointConnectivity);
    const resumeDetector = options.resumeDetector ?? createSystemResumeDetector();
    const maxOfflineWaitMs = options.maxOfflineWaitMs ?? NETWORK_OFFLINE_WAIT_LIMIT_MS;
    const nowMs = options.nowMs ?? Date.now;
    const deviceSignals = () => ({
        ...(options.isDeviceOnline ? { hostOnline: readSignal(options.isDeviceOnline) } : {}),
        routableInterface: readSignal(options.hasRoutableInterface ?? hasRoutableNetworkInterface),
    });
    const onlineDetector = options.onlineDetector ??
        createNetworkOnlineDetector({ hasNetwork: () => hasNetwork(deviceSignals()) });
    const hints = {
        onResume: (listener) => resumeDetector.onResume(listener),
        onOnline: (listener) => onlineDetector.onOnline(listener),
    };
    const report = (check) => {
        options.onOfflineCheck?.(check);
        return check.offline;
    };
    const reached = new Map();
    const reviewEndpoint = () => {
        const url = options.reviewEndpoint?.();
        return url ? networkEndpoint(url) : undefined;
    };
    /** Offline when the endpoint cannot be reached at all; a gateway on this machine always can. */
    const endpointOffline = async (endpoint, signal) => {
        const signals = deviceSignals();
        const verdict = await probe(endpoint, signal);
        return report({ ...signals, probe: verdict, offline: verdict === 'offline' });
    };
    /**
     * A content review asks the review service, or the most recently reached
     * model gateway when the service is unknown. Without either, only a device
     * without any routable interface is offline.
     */
    const anyGatewayOffline = async (signal) => {
        const target = reviewEndpoint() ?? [...reached.values()].at(-1);
        if (target)
            return endpointOffline(target, signal);
        const signals = deviceSignals();
        return report({ ...signals, offline: !signals.routableInterface });
    };
    return {
        maxOfflineWaitMs,
        markReachable(baseUrl) {
            const endpoint = networkEndpoint(baseUrl);
            if (!endpoint)
                return;
            const key = endpointKey(endpoint);
            reached.delete(key);
            reached.set(key, endpoint);
        },
        async isOffline(baseUrl, signal) {
            const endpoint = networkEndpoint(baseUrl);
            if (!endpoint)
                return false;
            return endpointOffline(endpoint, signal);
        },
        onResume: hints.onResume,
        onOnline: hints.onOnline,
        createOfflineWait: ({ signal, observer }) => createOfflineWait({
            deviceOffline: () => anyGatewayOffline(signal),
            hints,
            maxOfflineWaitMs,
            nowMs,
            ...(signal ? { signal } : {}),
            ...(observer ? { observer } : {}),
        }),
    };
}
function createOfflineWait(input) {
    // Bounded per offline period: the device coming back, or a wake, opens a fresh window.
    let offlineSinceMs;
    const cancelled = () => input.signal?.aborted === true;
    // A stop can land during any await, so it is checked before every probe and after it.
    const stillOffline = async () => !cancelled() && input.deviceOffline();
    const giveUp = async () => {
        await notify(() => input.observer?.resolved(false));
        return false;
    };
    const expired = (since) => cancelled() || input.nowMs() - since > input.maxOfflineWaitMs;
    return {
        async untilOnline() {
            if (!(await stillOffline()))
                return false;
            offlineSinceMs ??= input.nowMs();
            let polls = 0;
            while (await stillOffline()) {
                if (expired(offlineSinceMs))
                    return giveUp();
                polls += 1;
                const delayMs = Math.min(OFFLINE_POLL_MAX_MS, OFFLINE_POLL_BASE_MS * 2 ** (polls - 1));
                await notify(() => input.observer?.waiting(delayMs));
                const sleptFromMs = input.nowMs();
                const woke = await sleepUntilWake(delayMs, input.hints, input.signal);
                if (woke || overranSystemSleep(sleptFromMs, input.nowMs(), delayMs)) {
                    offlineSinceMs = input.nowMs();
                    polls = 0;
                }
            }
            if (cancelled())
                return giveUp();
            offlineSinceMs = undefined;
            await notify(() => input.observer?.resolved(true));
            return true;
        },
    };
}
/**
 * Sleep for `delayMs`; resolves true when a system wake cut it short, false
 * when it ran out, the Turn stopped or an online hint cut it short.
 */
function sleepUntilWake(delayMs, hints, signal) {
    return new Promise((resolve) => {
        // An abort that already fired never dispatches again.
        if (signal?.aborted) {
            resolve(false);
            return;
        }
        let unsubscribeResume = () => undefined;
        let unsubscribeOnline = () => undefined;
        const settle = (woke) => {
            clearTimeout(timer);
            unsubscribeResume();
            unsubscribeOnline();
            signal?.removeEventListener('abort', onAbort);
            resolve(woke);
        };
        const onAbort = () => settle(false);
        const timer = setTimeout(() => settle(false), delayMs);
        timer.unref?.();
        unsubscribeResume = hints.onResume(() => settle(true));
        unsubscribeOnline = hints.onOnline(() => settle(false));
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
/** Reporting a wait never changes it. */
async function notify(report) {
    try {
        await report();
    }
    catch {
        // Observability only.
    }
}
function hasNetwork(signals) {
    return signals.hostOnline !== false && signals.routableInterface;
}
/** A failing signal counts as online, so the bounded retry budget still applies. */
function readSignal(signal) {
    try {
        return signal();
    }
    catch {
        return true;
    }
}
function endpointKey(endpoint) {
    return `${endpoint.host}:${String(endpoint.port)}`;
}
//# sourceMappingURL=local-network-recovery.js.map