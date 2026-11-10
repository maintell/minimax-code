import { net } from "electron";
import { sanitizeAuthRefreshSummaryPayload, AUTH_REFRESH_SUMMARY_EVENT } from "../observability/auth-refresh-summary.js";
import { enqueueElectronObservabilityEvent, getElectronObservabilityAppInstanceId } from "../observability/outbox.js";
import logger from "../../utils/logger.js";
import { readAuthRefreshEnvironmentSnapshot } from "./refresh-environment.js";
const MAX_PENDING_STARTS = 16;
export function createAuthRefreshDiagnosticsSink(options = {}) {
    const emit = options.emit ?? enqueueElectronObservabilityEvent;
    const getAppInstanceId = options.getAppInstanceId ?? getElectronObservabilityAppInstanceId;
    const isOnline = options.isOnline ?? (() => net.isOnline());
    const readEnvironment = options.readEnvironment ?? readAuthRefreshEnvironmentSnapshot;
    const log = options.log ?? logger;
    const schedule = options.schedule ?? ((task) => void setImmediate(task));
    const electronVersion = 'electronVersion' in options ? options.electronVersion : process.versions.electron;
    // Bounded: a start without a summary (e.g. a crash) is evicted oldest-first.
    const onlineAtStart = new Map();
    const readOnlineHint = () => {
        try {
            const value = isOnline();
            return typeof value === 'boolean' ? value : null;
        }
        catch {
            return null;
        }
    };
    const processIdentity = () => {
        let appInstanceId;
        try {
            appInstanceId = getAppInstanceId();
        }
        catch {
            appInstanceId = undefined;
        }
        return {
            ...(typeof appInstanceId === 'string' ? { app_instance_id: appInstanceId } : {}),
            source_process: 'main',
        };
    };
    const handleStart = (event) => {
        const online = readOnlineHint();
        if (onlineAtStart.size >= MAX_PENDING_STARTS) {
            const oldest = onlineAtStart.keys().next().value;
            if (oldest !== undefined)
                onlineAtStart.delete(oldest);
        }
        onlineAtStart.set(event.correlationId, online);
        const payload = {
            ...sanitizeAuthRefreshSummaryPayload({
                ...event,
                network_online_hint_at_start: online,
            }),
            ...processIdentity(),
        };
        log.info(`[OAuth] auth.refresh_start ${JSON.stringify(payload)}`);
    };
    const handleSummary = (event) => {
        const startOnline = onlineAtStart.has(event.correlationId)
            ? (onlineAtStart.get(event.correlationId) ?? null)
            : null;
        onlineAtStart.delete(event.correlationId);
        let environment = {};
        try {
            environment = readEnvironment();
        }
        catch {
            environment = {};
        }
        const merged = {
            ...event,
            ...environment,
            network_online_hint_at_start: startOnline,
            network_online_hint: readOnlineHint(),
            proxy_mode_hint: 'unknown',
            ...(electronVersion ? { electron_version: electronVersion } : {}),
        };
        const payload = { ...sanitizeAuthRefreshSummaryPayload(merged), ...processIdentity() };
        const message = `[OAuth] auth.refresh_summary ${JSON.stringify(payload)}`;
        if (event.outcome === 'success')
            log.info(message);
        else
            log.warn(message);
        const eventKind = event.outcome === 'success' ? 'action' : 'error';
        // The outbox persists synchronously; keep it off the refresh call stack.
        schedule(() => {
            try {
                emit(AUTH_REFRESH_SUMMARY_EVENT, merged, eventKind);
            }
            catch {
                // Telemetry delivery must never affect auth.
            }
        });
    };
    return (event) => {
        try {
            if (event.event === 'auth.refresh_start')
                handleStart(event);
            else if (event.event === 'auth.refresh_summary')
                handleSummary(event);
        }
        catch {
            // Diagnostics must never affect auth.
        }
    };
}
