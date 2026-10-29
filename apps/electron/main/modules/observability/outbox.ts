import { readFileSync, existsSync, renameSync, unlinkSync, statSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { app, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../config/constants";
import { boundFailureDetail } from "./failure-detail";
import { sanitizeWorkspaceIndexingPayload } from "./workspace-indexing";
import logger from "../../utils/logger";
import { setupElectronStartupPerformanceIPC } from "./startup-performance";
import { readSystemSessionEndEvidence } from "./system-session-end";
const MAX_OUTBOX_EVENTS = 200;
const MAX_OUTBOX_BYTES = 5 * 1024 * 1024;
const appInstanceId = `app_${randomUUID()}`;
let probeInstallation;
let appQuitting = false;
let systemSessionEnd;
const expectedRendererExitUntil = new Map();
const ERROR_TYPES = new Set([
    'Error',
    'TypeError',
    'RangeError',
    'ReferenceError',
    'SyntaxError',
    'AggregateError',
]);
const GENERIC_CRASH_SOURCES = new Set([
    'main_unhandled_rejection',
    'main_uncaught_exception',
    'render_process_gone',
    'child_process_gone',
    'unclean_previous_session',
]);
const GENERIC_PROCESS_TYPES = new Set(['Renderer', 'GPU', 'Utility', 'Zygote']);
const GENERIC_REASONS = new Set([
    'clean-exit',
    'abnormal-exit',
    'killed',
    'crashed',
    'oom',
    'launch-failed',
    'integrity-failure',
    'memory-eviction',
]);
const GENERIC_PAGE_CLASSES = new Set(['unresponsive', 'load_failed']);
const NATIVE_FETCH_SOURCES = new Set(['download_prime', 'normal_quit', 'explicit_install']);
const OFFICE_PREVIEW_GUARD_KINDS = new Set(['lease_owner_lookup_failed', 'lease_owner_mismatch']);
function boundedValue(value, allowed) {
    return typeof value === 'string' && allowed.has(value) ? value : 'other';
}
function boundedErrorType(name) {
    return boundedValue(name, ERROR_TYPES);
}
function boundedProcessType(type) {
    return boundedValue(type, GENERIC_PROCESS_TYPES);
}
function boundedReason(reason) {
    return boundedValue(reason, GENERIC_REASONS);
}
const GENERIC_PLATFORMS = new Set([
    'darwin',
    'win32',
    'linux',
    'freebsd',
    'aix',
    'openbsd',
    'sunos',
]);
const GENERIC_ARCHES = new Set(['arm64', 'x64', 'ia32', 'arm', 'ppc64', 'ppc64le', 's390x']);
const APP_INSTANCE_ID_PATTERN = /^app_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_VERSION_PATTERN = /^[0-9A-Za-z._+-]{1,64}$/;
function safeCommonMetadata(payload) {
    const metadata = {};
    if (typeof payload.app_instance_id === 'string' &&
        APP_INSTANCE_ID_PATTERN.test(payload.app_instance_id)) {
        metadata.app_instance_id = payload.app_instance_id;
    }
    if (payload.source_process === 'main')
        metadata.source_process = 'main';
    if (typeof payload.app_version === 'string' && APP_VERSION_PATTERN.test(payload.app_version)) {
        metadata.app_version = payload.app_version;
    }
    if (payload.platform !== undefined) {
        metadata.platform = boundedValue(payload.platform, GENERIC_PLATFORMS);
    }
    if (payload.arch !== undefined)
        metadata.arch = boundedValue(payload.arch, GENERIC_ARCHES);
    return metadata;
}
const UTILITY_RUNTIME_FAILURE_PHASES = new Set(['startup', 'runtime']);
const UTILITY_RUNTIME_REASON_CODES = new Set([
    'runtime_owner_conflict',
    'process_exit',
    'init_failed',
    'bootstrap_timeout',
    'handshake_failed',
    'env_prepare_failed',
    'memory_pressure',
    'runtime_unresponsive',
    'oom',
    // Supervisor gave up on an already-ready runtime (crash-loop breaker).
    'crash_loop',
    'unknown',
]);
const UTILITY_RUNTIME_OUTCOMES = new Set(['recovered', 'terminal_failed', 'interrupted']);
const UTILITY_RUNTIME_AFTER_EXIT_INTENTS = new Set(['restart', 'retry-bootstrap', 'stay-stopped']);
const UTILITY_RUNTIME_NUMBER_FIELDS = [
    'attempt_count',
    'duration_ms',
    'continuity_epoch',
    'execution_gap_ms',
    'gap_threshold_ms',
    'wait_ms',
    'cooldown_ms',
];
const UTILITY_RUNTIME_BOOLEAN_FIELDS = ['quit_in_progress'];
const MAX_UTILITY_RUNTIME_STRING_LENGTH = 64;
const MAX_CRASHED_APP_VERSION_LENGTH = 32;
const MAX_CRASHED_APP_INSTANCE_ID_LENGTH = 64;
function exitCodeFields(value, prefix = '') {
    if (typeof value !== 'number' || !Number.isInteger(value))
        return {};
    const unsigned = value >>> 0;
    return {
        [prefix + 'exit_code']: unsigned,
        [prefix + 'exit_code_hex']: '0x' + unsigned.toString(16).toUpperCase(),
    };
}
function nativeProcessFields(payload) {
    const fields = exitCodeFields(payload.exit_code);
    // Electron-owned service/display names only; no paths, URLs or arbitrary messages.
    if (typeof payload.service_name === 'string' &&
        /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(payload.service_name)) {
        fields.service_name = payload.service_name;
    }
    if (typeof payload.process_name === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9_. ():-]{0,79}$/.test(payload.process_name)) {
        fields.process_name = payload.process_name;
    }
    return fields;
}
/**
 * Allowlist for utility runtime recovery events so future emitters cannot
 * widen this channel into free-form error/path telemetry by accident. Enum
 * fields collapse to 'other', exit_code is re-normalized to uint32 with a
 * derived hex mirror, and failure_detail goes through the same home-directory
 * redaction as the observer emit site, so the boundary holds for any caller.
 */
function sanitizeUtilityRuntimePayload(payload) {
    const sanitized = {
        ...safeCommonMetadata(payload),
        domain: 'utility_runtime',
    };
    const incidentId = payload.incident_id;
    if (typeof incidentId === 'string' && incidentId.length <= MAX_UTILITY_RUNTIME_STRING_LENGTH) {
        sanitized.incident_id = incidentId;
    }
    if (payload.failure_phase !== undefined) {
        sanitized.failure_phase = boundedValue(payload.failure_phase, UTILITY_RUNTIME_FAILURE_PHASES);
    }
    if (payload.reason_code !== undefined) {
        sanitized.reason_code = boundedValue(payload.reason_code, UTILITY_RUNTIME_REASON_CODES);
    }
    if (payload.outcome !== undefined) {
        sanitized.outcome = boundedValue(payload.outcome, UTILITY_RUNTIME_OUTCOMES);
    }
    if (payload.after_exit !== undefined) {
        sanitized.after_exit = boundedValue(payload.after_exit, UTILITY_RUNTIME_AFTER_EXIT_INTENTS);
    }
    if (typeof payload.exit_code === 'number' && Number.isInteger(payload.exit_code)) {
        const unsigned = payload.exit_code >>> 0;
        sanitized.exit_code = unsigned;
        // Derived, never trusted from the caller: the two must always agree.
        sanitized.exit_code_hex = `0x${unsigned.toString(16).toUpperCase()}`;
    }
    for (const field of UTILITY_RUNTIME_NUMBER_FIELDS) {
        const value = payload[field];
        if (typeof value === 'number' && Number.isFinite(value))
            sanitized[field] = value;
    }
    for (const field of UTILITY_RUNTIME_BOOLEAN_FIELDS) {
        if (payload[field] === true)
            sanitized[field] = true;
    }
    if (typeof payload.failure_detail === 'string') {
        sanitized.failure_detail = boundFailureDetail(payload.failure_detail);
    }
    if (payload.last_failure_phase !== undefined) {
        sanitized.last_failure_phase = boundedValue(payload.last_failure_phase, UTILITY_RUNTIME_FAILURE_PHASES);
    }
    if (payload.last_failure_reason !== undefined) {
        sanitized.last_failure_reason = boundedValue(payload.last_failure_reason, UTILITY_RUNTIME_REASON_CODES);
    }
    if (typeof payload.last_failure_attempt_id === 'string' &&
        /^[A-Za-z0-9_-]{1,64}$/.test(payload.last_failure_attempt_id)) {
        sanitized.last_failure_attempt_id = payload.last_failure_attempt_id;
    }
    Object.assign(sanitized, exitCodeFields(payload.last_failure_exit_code, 'last_failure_'));
    if (typeof payload.last_failure_detail === 'string') {
        sanitized.last_failure_detail = boundFailureDetail(payload.last_failure_detail);
    }
    return sanitized;
}
const HOT_UPDATE_CHANNELS = new Set(['prod', 'internal', 'inside', 'staging', 'test', 'none']);
const HOT_UPDATE_RESULTS = new Set(['success', 'error', 'rejected', 'available', 'up_to_date']);
const HOT_UPDATE_VERSION_PATTERN = /^(bundled|\d+\.\d+\.\d+-renderer\.\d+)$/;
/** hot_update.* 只保留通道、版本、结果等有限字段；reason 走路径脱敏与长度上限 */
function sanitizeHotUpdatePayload(payload) {
    const sanitized = {
        ...safeCommonMetadata(payload),
        domain: 'hot_update',
        channel: boundedValue(payload.channel, HOT_UPDATE_CHANNELS),
    };
    if (typeof payload.version === 'string' && HOT_UPDATE_VERSION_PATTERN.test(payload.version)) {
        sanitized.version = payload.version;
    }
    if (payload.result !== undefined) {
        sanitized.result = boundedValue(payload.result, HOT_UPDATE_RESULTS);
    }
    if (typeof payload.reason === 'string') {
        sanitized.reason = boundFailureDetail(payload.reason);
    }
    if (typeof payload.duration_ms === 'number' && Number.isFinite(payload.duration_ms)) {
        sanitized.duration_ms = payload.duration_ms;
    }
    if (typeof payload.promoted === 'boolean')
        sanitized.promoted = payload.promoted;
    return sanitized;
}
function sanitizeGenericProbePayload(eventName, payload) {
    if (eventName === 'workspace_indexing.state') {
        return { ...safeCommonMetadata(payload), ...sanitizeWorkspaceIndexingPayload(payload) };
    }
    if (eventName === 'app.crash') {
        // `source` collides with the RUM SDK's built-in source dimension and is
        // masked in analytics queries; `crash_source` is the queryable mirror.
        // Keep `source` for one release so existing panels stay readable.
        const crashSource = boundedValue(payload.crash_source ?? payload.source, GENERIC_CRASH_SOURCES);
        return {
            ...safeCommonMetadata(payload),
            domain: 'stability',
            incident: 'app.crash',
            source: crashSource,
            crash_source: crashSource,
            ...(payload.error_type !== undefined
                ? { error_type: boundedErrorType(payload.error_type) }
                : {}),
            ...(payload.process_type !== undefined
                ? { process_type: boundedProcessType(payload.process_type) }
                : {}),
            ...(payload.reason !== undefined ? { reason: boundedReason(payload.reason) } : {}),
            ...nativeProcessFields(payload),
            ...readSystemSessionEndEvidence(payload),
            ...(typeof payload.has_native_dump === 'boolean'
                ? { has_native_dump: payload.has_native_dump }
                : {}),
            // Attribution of an unclean_previous_session report: the event describes
            // the session that died, so the current app_version/app_instance_id
            // stamped by safeCommonMetadata would misfile it after an upgrade.
            // Dropped rather than truncated when over-long - a mangled version
            // string is worse than an absent one.
            ...(typeof payload.crashed_app_version === 'string' &&
                payload.crashed_app_version.length <= MAX_CRASHED_APP_VERSION_LENGTH
                ? { crashed_app_version: payload.crashed_app_version }
                : {}),
            ...(typeof payload.crashed_app_instance_id === 'string' &&
                payload.crashed_app_instance_id.length <= MAX_CRASHED_APP_INSTANCE_ID_LENGTH
                ? { crashed_app_instance_id: payload.crashed_app_instance_id }
                : {}),
        };
    }
    if (eventName === 'app.system_session_end') {
        return {
            ...safeCommonMetadata(payload),
            domain: 'stability',
            ...readSystemSessionEndEvidence(payload),
        };
    }
    // Prefix match is deliberate: any utility_runtime.* event that has not been
    // added to the allowlist gets its unknown fields dropped (fail-closed)
    // instead of bypassing the boundary entirely. Extend the allowlist when a
    // sibling event with a different shape starts flowing through the outbox.
    if (eventName.startsWith('utility_runtime.')) {
        return sanitizeUtilityRuntimePayload(payload);
    }
    if (eventName.startsWith('hot_update.')) {
        return sanitizeHotUpdatePayload(payload);
    }
    if (eventName === 'desktop.abnormal_page') {
        return {
            ...safeCommonMetadata(payload),
            domain: 'app',
            abnormal_page: boundedValue(payload.abnormal_page, GENERIC_PAGE_CLASSES),
        };
    }
    if (eventName === 'office_preview_guard_hit') {
        return {
            ...safeCommonMetadata(payload),
            domain: 'office_preview',
            kind: boundedValue(payload.kind, OFFICE_PREVIEW_GUARD_KINDS),
        };
    }
    return payload;
}
function sanitizeObservabilityPayload(eventName, payload) {
    const sanitized = sanitizeGenericProbePayload(eventName, payload);
    if (eventName !== 'updater.native_fetch')
        return sanitized;
    const nativeFetchSource = sanitized.native_fetch_source ?? sanitized.source;
    const nativeFetchPayload = { ...sanitized };
    delete nativeFetchPayload.source;
    delete nativeFetchPayload.native_fetch_source;
    if (typeof nativeFetchSource === 'string' && NATIVE_FETCH_SOURCES.has(nativeFetchSource)) {
        nativeFetchPayload.native_fetch_source = nativeFetchSource;
    }
    return nativeFetchPayload;
}
function warnSafely(message) {
    try {
        logger.warn(message);
    }
    catch {
        // Diagnostics must not become process control.
    }
}
function getOutboxPath() {
    return path.join(app.getPath('userData'), 'observability-outbox.jsonl');
}
function parseOutboxLine(line) {
    try {
        const parsed = JSON.parse(line);
        if (typeof parsed.id !== 'string' ||
            typeof parsed.eventName !== 'string' ||
            (parsed.eventKind !== undefined &&
                parsed.eventKind !== 'action' &&
                parsed.eventKind !== 'error') ||
            typeof parsed.createdAt !== 'number' ||
            !parsed.payload ||
            typeof parsed.payload !== 'object' ||
            Array.isArray(parsed.payload)) {
            return null;
        }
        const payload = parsed.payload;
        if (parsed.eventName === 'app.crash' &&
            payload.source === 'child_process_gone' &&
            payload.reason === 'clean-exit') {
            return null;
        }
        return {
            id: parsed.id,
            eventName: parsed.eventName,
            ...(parsed.eventKind ? { eventKind: parsed.eventKind } : {}),
            // Sanitize historical records too. An outbox can survive an app
            // upgrade, so protecting only newly enqueued events would still upload
            // raw fields written by an older build on the next startup.
            payload: sanitizeObservabilityPayload(parsed.eventName, payload),
            createdAt: parsed.createdAt,
        };
    }
    catch {
        return null;
    }
}
/**
 * Tombstone line appended when a renderer confirms it handed a live event to
 * the RUM SDK. Without it, live-delivered events survive in the file and get
 * re-reported by the next launch's drain (at-least-once became at-least-twice
 * for every event delivered while a window was open).
 */
function parseAckLine(line) {
    try {
        const parsed = JSON.parse(line);
        return typeof parsed.ack === 'string' && parsed.ack.length <= 128 ? parsed.ack : null;
    }
    catch {
        return null;
    }
}
function readOutboxFile(filePath = getOutboxPath()) {
    try {
        const contents = readFileSync(filePath, 'utf8');
        const lines = contents
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
        const acknowledgedIds = new Set();
        for (const line of lines) {
            const ackedId = parseAckLine(line);
            if (ackedId)
                acknowledgedIds.add(ackedId);
        }
        return lines
            .map(parseOutboxLine)
            .filter((event) => event !== null)
            .filter((event) => !acknowledgedIds.has(event.id))
            .slice(-MAX_OUTBOX_EVENTS);
    }
    catch {
        return [];
    }
}
function takeOutboxFile() {
    const outboxPath = getOutboxPath();
    if (!existsSync(outboxPath))
        return null;
    const drainingPath = `${outboxPath}.${Date.now()}.${randomUUID()}.draining`;
    try {
        renameSync(outboxPath, drainingPath);
        return drainingPath;
    }
    catch (error) {
        logger.warn(`[ObservabilityOutbox] Failed to take outbox file: ${String(error)}`);
        return null;
    }
}
function removeDrainedOutboxFile(filePath) {
    try {
        unlinkSync(filePath);
    }
    catch {
        // The file has already served as a best-effort transfer buffer.
    }
}
function compactOutboxFileIfNeeded(filePath = getOutboxPath()) {
    try {
        if (!existsSync(filePath) || statSync(filePath).size <= MAX_OUTBOX_BYTES)
            return;
        const retainedEvents = readOutboxFile(filePath);
        if (retainedEvents.length === 0) {
            unlinkSync(filePath);
            return;
        }
        writeFileSync(filePath, `${retainedEvents.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
        logger.warn(`[ObservabilityOutbox] Compacted oversized outbox to ${retainedEvents.length} events`);
    }
    catch (error) {
        logger.warn(`[ObservabilityOutbox] Failed to compact outbox file: ${String(error)}`);
    }
}
/**
 * Most-recent-first stack of windows that have proven their RUM pipeline is
 * ready by draining. Delivery stays unicast (the double-report fix), but a
 * destroyed reporter falls back to the next live drainer instead of silencing
 * telemetry for the rest of the session.
 */
const outboxDrainers = [];
const MAX_OUTBOX_DRAINERS = 8;
/**
 * Events handed to a live reporter but not yet acknowledged. A concurrent
 * drain from another window must not re-deliver them; entries expire so a
 * reporter that dies before acking cannot pin an event out of delivery
 * forever (the event is still on disk and resurfaces on a later drain).
 */
const pendingLiveAck = new Map();
const PENDING_LIVE_ACK_TTL_MS = 60000;
function registerOutboxDrainer(sender) {
    const existing = outboxDrainers.indexOf(sender);
    if (existing >= 0)
        outboxDrainers.splice(existing, 1);
    outboxDrainers.push(sender);
    if (outboxDrainers.length > MAX_OUTBOX_DRAINERS)
        outboxDrainers.shift();
}
function sweepPendingLiveAck(nowMs) {
    for (const [id, deliveredAt] of pendingLiveAck) {
        if (nowMs - deliveredAt > PENDING_LIVE_ACK_TTL_MS)
            pendingLiveAck.delete(id);
    }
}
function deliverOutboxEvent(event) {
    for (let index = outboxDrainers.length - 1; index >= 0; index -= 1) {
        const target = outboxDrainers[index];
        if (!target || target.isDestroyed()) {
            outboxDrainers.splice(index, 1);
            continue;
        }
        target.send(IPC_CHANNELS.OBSERVABILITY_OUTBOX_EVENT, event);
        pendingLiveAck.set(event.id, Date.now());
        return;
    }
}
export function getElectronObservabilityAppInstanceId() {
    return appInstanceId;
}
export function enqueueElectronObservabilityEvent(eventName, payload = {}, eventKind = 'action') {
    try {
        enqueuePreparedEvent(eventName, payload, eventKind);
    }
    catch {
        // Includes context getters, sanitization, UUID/time acquisition and serialization.
        warnSafely('[ObservabilityOutbox] Failed to prepare event');
    }
}
function enqueuePreparedEvent(eventName, payload, eventKind) {
    const safePayload = sanitizeObservabilityPayload(eventName, payload);
    const event = {
        id: randomUUID(),
        eventName,
        ...(eventKind === 'error' ? { eventKind } : {}),
        createdAt: Date.now(),
        payload: {
            app_instance_id: appInstanceId,
            source_process: 'main',
            app_version: safeAppVersion(),
            platform: process.platform,
            arch: process.arch,
            ...safePayload,
        },
    };
    try {
        const outboxPath = getOutboxPath();
        mkdirSync(path.dirname(outboxPath), { recursive: true });
        compactOutboxFileIfNeeded(outboxPath);
        appendFileSync(outboxPath, `${JSON.stringify(event)}\n`, 'utf8');
    }
    catch (error) {
        warnSafely(`[ObservabilityOutbox] Failed to persist event: ${String(error)}`);
    }
    try {
        deliverOutboxEvent(event);
    }
    catch (error) {
        warnSafely(`[ObservabilityOutbox] Failed to deliver event: ${String(error)}`);
    }
}
function safeAppVersion() {
    try {
        const version = app.getVersion();
        return typeof version === 'string' && version.length > 0 ? version : 'unknown';
    }
    catch {
        return 'unknown';
    }
}
/** Mark a renderer crash caused by our own recovery flow as expected telemetry. */
export function markElectronObservabilityExpectedRendererExit(windowId, untilMs = Date.now() + 10000) {
    expectedRendererExitUntil.set(windowId, untilMs);
}
/** Suppress generic renderer crash probes while the app is already shutting down. */
export function setElectronObservabilityShuttingDown(value) {
    appQuitting = value;
}
/**
 * True once the quit sequence started. Emitters use this to mark incidents
 * that are expected shutdown noise rather than real runtime failures.
 */
export function isElectronObservabilityShuttingDown() {
    return appQuitting;
}
const MAX_ACK_BATCH = 500;
function acknowledgeOutboxEvents(ids) {
    if (!Array.isArray(ids))
        return;
    for (const id of ids) {
        if (typeof id === 'string')
            pendingLiveAck.delete(id);
    }
    const validIds = ids
        .filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 128)
        .slice(0, MAX_ACK_BATCH);
    if (validIds.length === 0)
        return;
    try {
        const outboxPath = getOutboxPath();
        mkdirSync(path.dirname(outboxPath), { recursive: true });
        appendFileSync(outboxPath, `${validIds.map((id) => JSON.stringify({ ack: id })).join('\n')}\n`, 'utf8');
    }
    catch (error) {
        warnSafely(`[ObservabilityOutbox] Failed to record acknowledgements: ${String(error)}`);
    }
}
export function setupElectronObservabilityOutbox() {
    ipcMain.on(IPC_CHANNELS.OBSERVABILITY_GET_APP_INSTANCE_ID, (event) => {
        event.returnValue = appInstanceId;
    });
    ipcMain.handle(IPC_CHANNELS.OBSERVABILITY_GET_APP_INSTANCE_ID, () => appInstanceId);
    ipcMain.handle(IPC_CHANNELS.OBSERVABILITY_DRAIN_OUTBOX, (event) => {
        // The drainer just proved its RUM pipeline is ready; make it the live
        // delivery target until a newer drainer appears or it goes away.
        const sender = event?.sender;
        if (sender && typeof sender.isDestroyed === 'function' && !sender.isDestroyed()) {
            registerOutboxDrainer(sender);
        }
        const drainingPath = takeOutboxFile();
        if (!drainingPath)
            return [];
        sweepPendingLiveAck(Date.now());
        // Exclude events another window received live but has not acked yet;
        // returning them here would recreate the cross-window double report.
        const events = [];
        const withheld = [];
        for (const outboxEvent of readOutboxFile(drainingPath)) {
            (pendingLiveAck.has(outboxEvent.id) ? withheld : events).push(outboxEvent);
        }
        // Withheld events must keep a persistent copy: the drained file is about
        // to be deleted, and if the live reporter dies before acking, the disk
        // copy is the only path back (via TTL expiry and a later drain). If the
        // rewrite fails, hand them to this drainer instead - a duplicate report
        // is recoverable, a lost crash report is not.
        if (withheld.length > 0) {
            try {
                const outboxPath = getOutboxPath();
                mkdirSync(path.dirname(outboxPath), { recursive: true });
                appendFileSync(outboxPath, `${withheld.map((outboxEvent) => JSON.stringify(outboxEvent)).join('\n')}\n`, 'utf8');
            }
            catch (error) {
                warnSafely(`[ObservabilityOutbox] Failed to preserve unacked live events: ${String(error)}`);
                events.push(...withheld);
            }
        }
        removeDrainedOutboxFile(drainingPath);
        return events;
    });
    ipcMain.handle(IPC_CHANNELS.OBSERVABILITY_ACK_OUTBOX, (_event, ids) => {
        acknowledgeOutboxEvents(ids);
    });
    setupElectronStartupPerformanceIPC({
        ipcMain: ipcMain,
        channel: IPC_CHANNELS.OBSERVABILITY_STARTUP_MILESTONE,
        enqueue: enqueueElectronObservabilityEvent,
    });
}
export function installElectronObservabilityProbes(options = {}) {
    if (probeInstallation)
        return;
    enqueueElectronObservabilityEvent('app.instance_start', {
        domain: 'app',
        instance_source: 'main_process',
        started_at: Date.now(),
        app_name: app.getName(),
        app_version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        electron_version: process.versions.electron,
        chrome_version: process.versions.chrome,
    });
    const mainExceptionMonitor = (error, origin) => {
        const source = origin === 'unhandledRejection' ? 'main_unhandled_rejection' : 'main_uncaught_exception';
        enqueueElectronObservabilityEvent('app.crash', {
            domain: 'stability',
            incident: 'app.crash',
            source,
            error_type: boundedErrorType(error.name),
        });
        try {
            logger.error({
                msg: '[ObservabilityOutbox] Main process exception observed',
                source,
                error_name: error.name,
                error_message: error.message,
            });
        }
        catch {
            // The monitor must never turn a diagnostic failure into process control.
        }
    };
    const windowCleanups = new Set();
    const onBrowserWindowCreated = (_event, window) => {
        const onUnresponsive = () => {
            enqueueElectronObservabilityEvent('desktop.abnormal_page', {
                domain: 'app',
                abnormal_page: 'unresponsive',
            });
        };
        const onRenderProcessGone = (_goneEvent, details) => {
            try {
                const expectedUntil = expectedRendererExitUntil.get(window.id);
                if (expectedUntil !== undefined) {
                    if (expectedUntil >= Date.now() &&
                        (details.reason === 'killed' || details.reason === 'crashed')) {
                        expectedRendererExitUntil.delete(window.id);
                        return;
                    }
                    if (expectedUntil < Date.now())
                        expectedRendererExitUntil.delete(window.id);
                }
                if (appQuitting || details.reason === 'clean-exit')
                    return;
                enqueueElectronObservabilityEvent('app.crash', {
                    domain: 'stability',
                    incident: 'app.crash',
                    source: 'render_process_gone',
                    reason: boundedReason(details.reason),
                    process_type: 'Renderer',
                    exit_code: details.exitCode,
                    ...systemSessionEnd,
                });
            }
            catch {
                // Native event delivery must continue even when diagnostic context is unavailable.
            }
        };
        const observeSessionEnd = (phase, event) => {
            try {
                if (systemSessionEnd?.system_session_end_phase === 'end_received')
                    return;
                const evidence = readSystemSessionEndEvidence({
                    system_session_end_phase: phase,
                    system_session_end_reasons: event.reasons,
                    system_session_end_at: Date.now(),
                });
                if (!evidence)
                    return;
                systemSessionEnd = evidence;
                try {
                    // Persist before delivery; neither failure affects Windows' event/quit handling.
                    options.onSystemSessionEnd?.(evidence);
                }
                catch {
                    // The live event remains useful even if the marker cannot be updated.
                }
                enqueueElectronObservabilityEvent('app.system_session_end', { ...evidence });
            }
            catch {
                // Observe only. Never preventDefault, requestQuit, or change recovery state here.
            }
        };
        const onQuerySessionEnd = (event) => observeSessionEnd('query_received', event);
        const onSessionEnd = (event) => observeSessionEnd('end_received', event);
        const onDidFailLoad = (_loadEvent, errorCode, _errorDescription, _url) => {
            if (errorCode === -3)
                return;
            enqueueElectronObservabilityEvent('desktop.abnormal_page', {
                domain: 'app',
                abnormal_page: 'load_failed',
            });
        };
        const cleanup = () => {
            // Electron may invalidate WebContents before it emits `destroyed`;
            // removing a listener from that object can then throw. Each removal is
            // best effort so the persistent probe never becomes an exception source.
            try {
                window.removeListener('unresponsive', onUnresponsive);
                window.removeListener('query-session-end', onQuerySessionEnd);
                window.removeListener('session-end', onSessionEnd);
            }
            catch {
                // Window teardown is already in progress.
            }
            for (const remove of [
                () => window.webContents.removeListener('render-process-gone', onRenderProcessGone),
                () => window.webContents.removeListener('did-fail-load', onDidFailLoad),
                () => window.webContents.removeListener('destroyed', cleanup),
            ]) {
                try {
                    remove();
                }
                catch {
                    // WebContents has already been destroyed.
                }
            }
            windowCleanups.delete(cleanup);
        };
        windowCleanups.add(cleanup);
        window.on('unresponsive', onUnresponsive);
        window.on('query-session-end', onQuerySessionEnd);
        window.on('session-end', onSessionEnd);
        window.webContents.on('render-process-gone', onRenderProcessGone);
        window.webContents.on('did-fail-load', onDidFailLoad);
        window.webContents.on('destroyed', cleanup);
    };
    const onChildProcessGone = (_event, details) => {
        try {
            // Mirror the renderer probe semantics: expected exits (clean-exit) and
            // child teardown during app shutdown are not crashes and must not inflate
            // the app.crash stability metric.
            if (appQuitting || details.reason === 'clean-exit')
                return;
            enqueueElectronObservabilityEvent('app.crash', {
                domain: 'stability',
                incident: 'app.crash',
                source: 'child_process_gone',
                process_type: boundedProcessType(details.type),
                reason: boundedReason(details.reason),
                service_name: details.serviceName,
                process_name: details.name,
                exit_code: details.exitCode,
                ...systemSessionEnd,
            });
        }
        catch {
            // Do not let diagnostics interrupt Electron's other native lifecycle observers.
        }
    };
    probeInstallation = {
        mainExceptionMonitor,
        onBrowserWindowCreated,
        onChildProcessGone,
        windowCleanups,
    };
    process.on('uncaughtExceptionMonitor', mainExceptionMonitor);
    app.on('browser-window-created', onBrowserWindowCreated);
    app.on('child-process-gone', onChildProcessGone);
}
export function resetElectronObservabilityProbesForTests() {
    systemSessionEnd = undefined;
    appQuitting = false;
    expectedRendererExitUntil.clear();
    outboxDrainers.length = 0;
    pendingLiveAck.clear();
    const installation = probeInstallation;
    if (!installation)
        return;
    probeInstallation = undefined;
    process.removeListener('uncaughtExceptionMonitor', installation.mainExceptionMonitor);
    app.removeListener('browser-window-created', installation.onBrowserWindowCreated);
    app.removeListener('child-process-gone', installation.onChildProcessGone);
    for (const cleanup of [...installation.windowCleanups])
        cleanup();
}
