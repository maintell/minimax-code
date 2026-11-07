/**
 * Local-runtime utility process server — wires the control plane
 * (parentPort messages from Electron main) to the runtime transport data
 * plane (MessagePorts direct to renderers).
 *
 * This module is deliberately dependency-injected (no `electron` /
 * `process.parentPort` imports) so the full lifecycle is unit-testable; the
 * thin `entry.ts` bootstrap binds it to the real utility process globals.
 *
 * Lifecycle (proposal §2.5):
 * - `runtime-init` -> prepareRuntime() -> `runtime-ready` /
 *   `runtime-init-failed`.
 * - `runtime-port-connect` (+ transferred MessagePortMain) -> one transport
 *   host per renderer connection; ports arriving before the runtime is
 *   ready are queued and wired on `runtime-ready`.
 * - `runtime-auth-context` -> forwarded to the runtime surface.
 * - `runtime-shutdown` -> drain: stop serving ports, flush/shutdown the
 *   runtime within the grace window, then exit. Main force-kills the
 *   process if the drain outlives its own timeout.
 */

import { MAX_RUNTIME_INIT_FAILURE_DETAIL_LENGTH, isUtilityControlMessage } from "./control";
import { findRuntimeOwnerConflict } from "./runtime-owner-conflict";
const DEFAULT_DRAIN_GRACE_MS = 7000;
const DEFAULT_HEALTH_INTERVAL_MS = 10000;
const MAX_RECENTLY_CLOSED_CONNECTIONS = 256;
const MAX_RUNTIME_INIT_DIAGNOSTIC_CAUSES = 6;
/**
 * Collapses an init failure into one sanitized single-line diagnostic
 * (name/message + first stack frame and related error chain, newlines and control
 * characters stripped, bounded length) that is safe for piped stdio logs and the control-plane
 * `runtime-init-failed.detail` field. Always emitted: a generic
 * "initialization failed" without the underlying error has repeatedly sent
 * investigations to the wrong layer (e.g. native module ABI mismatches
 * misread as regressions of the utility-runtime migration).
 */
export function formatRuntimeInitDiagnostic(error) {
    const chain = [];
    const seen = new Set();
    const pending = [error];
    while (pending.length > 0 && chain.length < MAX_RUNTIME_INIT_DIAGNOSTIC_CAUSES) {
        const current = pending.shift();
        if (current === undefined)
            continue;
        if (typeof current === 'object' && current !== null) {
            if (seen.has(current))
                continue;
            seen.add(current);
        }
        chain.push(formatDiagnosticError(current));
        const cause = readErrorCause(current);
        if (cause !== undefined)
            pending.push(cause);
        pending.push(...readAggregateErrors(current));
    }
    if (pending.length > 0 && chain.length === MAX_RUNTIME_INIT_DIAGNOSTIC_CAUSES) {
        chain.push('[cause chain truncated]');
    }
    return (chain
        .join(' | caused by ')
        .replace(/[\r\n]+/g, ' | ')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .slice(0, MAX_RUNTIME_INIT_FAILURE_DETAIL_LENGTH) || 'Error: unknown');
}
function formatDiagnosticError(error) {
    if (!(error instanceof Error))
        return `Error: ${String(error)}`;
    const name = error.name.trim() || 'Error';
    const firstFrame = error.stack
        ?.split(/\r?\n/)
        .slice(1)
        .find((line) => line.trimStart().startsWith('at '))
        ?.trim();
    return `${name}: ${error.message}${firstFrame ? ` (${firstFrame})` : ''}`;
}
function readErrorCause(error) {
    if (typeof error !== 'object' || error === null || !('cause' in error))
        return undefined;
    return error.cause;
}
function readAggregateErrors(error) {
    if (typeof error !== 'object' || error === null || !('errors' in error))
        return [];
    const { errors } = error;
    return Array.isArray(errors) ? errors : [];
}
export function startLocalRuntimeUtilityServer(options) {
    const { parentPort, prepareRuntime, exit } = options;
    const drainGraceMs = options.drainGraceMs ?? DEFAULT_DRAIN_GRACE_MS;
    const log = options.log ?? (() => { });
    let phase = 'idle';
    let surface = null;
    /**
     * Latest auth rotation that arrived while prepareRuntime was still
     * running. Auth context is last-writer-wins, so transitional-state
     * arrivals are latched (not queued, not dropped) and applied before
     * runtime-ready — a rotation must never be lost to a startup window.
     */
    let pendingAuthContext = null;
    let pendingContextWindowUsageEnabled = null;
    let pendingRunawayGuardConfig = null;
    let pendingPromptSuggestionPolicy = null;
    let pendingToolResultCompactionConfig = null;
    let pendingCollectionPolicy = null;
    let pendingComputerUseChannel = null;
    let pendingAuthRequestIds = [];
    let pendingRoutingContext;
    let hasPendingRoutingContext = false;
    let authRotationTail = Promise.resolve();
    let healthSequence = 0;
    let healthTimer = null;
    let streamCoordinator = null;
    const pendingPorts = new Map();
    const connections = new Map();
    const recentlyClosedConnections = new Map();
    function stopHealthReporting() {
        if (!healthTimer)
            return;
        clearInterval(healthTimer);
        healthTimer = null;
    }
    function reportHealth() {
        if (phase !== 'ready' || !options.sampleHealth)
            return;
        try {
            parentPort.postMessage({
                type: 'runtime-health',
                sequence: healthSequence,
                ...options.sampleHealth(),
            });
            healthSequence += 1;
        }
        catch {
            log('runtime health report failed');
        }
    }
    function startHealthReporting() {
        if (!options.sampleHealth || healthTimer)
            return;
        reportHealth();
        const intervalMs = options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
        healthTimer = setInterval(reportHealth, intervalMs);
        healthTimer.unref?.();
    }
    function rememberRemoteClose(connectionId, abortedRequests) {
        recentlyClosedConnections.delete(connectionId);
        recentlyClosedConnections.set(connectionId, { abortedRequests });
        if (recentlyClosedConnections.size <= MAX_RECENTLY_CLOSED_CONNECTIONS)
            return;
        const oldestConnectionId = recentlyClosedConnections.keys().next().value;
        if (oldestConnectionId !== undefined)
            recentlyClosedConnections.delete(oldestConnectionId);
    }
    function consumeRemoteClose(connectionId) {
        const closed = recentlyClosedConnections.get(connectionId);
        recentlyClosedConnections.delete(connectionId);
        return closed ? { released: true, abortedRequests: closed.abortedRequests } : null;
    }
    function closeConnection(connectionId) {
        let released = false;
        let abortedRequests = 0;
        const pending = pendingPorts.get(connectionId);
        if (pending) {
            released = true;
            pendingPorts.delete(connectionId);
            try {
                pending.close();
            }
            catch {
                // Port may already be gone with its renderer.
            }
        }
        const active = connections.get(connectionId);
        if (active) {
            released = true;
            abortedRequests = active.host.inFlightCount();
            connections.delete(connectionId);
            active.host.close();
            try {
                active.port.close();
            }
            catch {
                // Port may already be gone with its renderer.
            }
        }
        return { released, abortedRequests };
    }
    function wirePort(connectionId, port) {
        if (!surface || !streamCoordinator)
            return;
        recentlyClosedConnections.delete(connectionId);
        closeConnection(connectionId);
        const host = surface.createTransportHost({
            handleRequest: surface.handleRequest,
            post: (frame) => {
                try {
                    port.postMessage(frame);
                }
                catch (error) {
                    log('transport port post failed');
                    // Rethrow so the transport host fails the affected request instead
                    // of leaving the renderer waiting on frames that never arrive.
                    throw error;
                }
            },
            onWarning: log,
            streamCoordinator,
            streamScope: connectionId,
        });
        connections.set(connectionId, { port, host });
        port.on('message', (event) => {
            host.handleFrame(event.data);
        });
        port.on('close', () => {
            if (connections.get(connectionId)?.port !== port)
                return;
            const abortedRequests = host.inFlightCount();
            connections.delete(connectionId);
            host.close();
            rememberRemoteClose(connectionId, abortedRequests);
        });
        port.start();
    }
    function closeConnections() {
        for (const { port, host } of connections.values()) {
            host.close();
            try {
                port.close();
            }
            catch {
                // Port may already be gone with its renderer.
            }
        }
        connections.clear();
        for (const port of pendingPorts.values()) {
            try {
                port.close();
            }
            catch {
                // Ignore: closing an unstarted port is best-effort.
            }
        }
        pendingPorts.clear();
        recentlyClosedConnections.clear();
        streamCoordinator?.clear();
        streamCoordinator = null;
    }
    function closePendingComputerUseChannel() {
        const pending = pendingComputerUseChannel;
        pendingComputerUseChannel = null;
        if (!pending)
            return;
        try {
            pending.port.close();
        }
        catch {
            // Ignore: closing an unstarted port is best-effort.
        }
    }
    function attachComputerUseChannel(port, generation) {
        if (!surface?.setComputerUsePort) {
            try {
                port.close();
            }
            catch {
                // Nothing else owns the transferred port.
            }
            return;
        }
        try {
            surface.setComputerUsePort(port, generation);
        }
        catch {
            try {
                port.close();
            }
            catch {
                // Nothing else owns the transferred port.
            }
            log('computer-use channel attach failed');
        }
    }
    function acknowledgeAuthRequests(requestIds) {
        for (const requestId of requestIds) {
            parentPort.postMessage({ type: 'runtime-auth-context-applied', requestId });
        }
    }
    async function applyPendingAuthContext() {
        while (pendingAuthContext && surface) {
            const next = pendingAuthContext;
            const requestIds = pendingAuthRequestIds;
            pendingAuthContext = null;
            pendingAuthRequestIds = [];
            await surface.setAuthContext(next.authContext);
            acknowledgeAuthRequests(requestIds);
        }
    }
    function applyPendingRoutingContext() {
        if (!hasPendingRoutingContext || !surface)
            return;
        const next = pendingRoutingContext;
        hasPendingRoutingContext = false;
        pendingRoutingContext = undefined;
        surface.setRoutingContext(next);
    }
    function enqueueAuthContext(message) {
        authRotationTail = authRotationTail
            .then(async () => {
            if (phase !== 'ready' || !surface)
                return;
            await surface.setAuthContext(message.authContext);
            acknowledgeAuthRequests([message.requestId]);
        })
            .catch(() => {
            log('auth rotation failed');
        });
    }
    async function handleInit(init, transferredPorts) {
        if (phase !== 'idle') {
            log(`duplicate runtime-init ignored (phase=${phase})`);
            return;
        }
        phase = 'starting';
        try {
            const ports = transferredPorts && transferredPorts.length > 0 ? transferredPorts : undefined;
            surface = ports ? await prepareRuntime(init, ports) : await prepareRuntime(init);
            if (pendingContextWindowUsageEnabled !== null) {
                surface.setContextWindowUsageEnabled(pendingContextWindowUsageEnabled);
                pendingContextWindowUsageEnabled = null;
            }
            if (pendingRunawayGuardConfig !== null) {
                surface.setRunawayGuardConfig(pendingRunawayGuardConfig);
                pendingRunawayGuardConfig = null;
            }
            if (pendingPromptSuggestionPolicy !== null) {
                surface.setPromptSuggestionPolicy(pendingPromptSuggestionPolicy);
                pendingPromptSuggestionPolicy = null;
            }
            if (pendingToolResultCompactionConfig !== null) {
                surface.setToolResultCompactionConfig(pendingToolResultCompactionConfig);
                pendingToolResultCompactionConfig = null;
            }
            if (pendingCollectionPolicy !== null) {
                surface.setCollectionPolicy(pendingCollectionPolicy);
                pendingCollectionPolicy = null;
            }
            streamCoordinator = surface.createStreamCoordinator();
            await applyPendingAuthContext();
            applyPendingRoutingContext();
            if (pendingComputerUseChannel) {
                const pending = pendingComputerUseChannel;
                pendingComputerUseChannel = null;
                attachComputerUseChannel(pending.port, pending.generation);
            }
            phase = 'ready';
            const queuedPorts = [...pendingPorts];
            pendingPorts.clear();
            for (const [connectionId, port] of queuedPorts)
                wirePort(connectionId, port);
            parentPort.postMessage({ type: 'runtime-ready' });
            startHealthReporting();
        }
        catch (error) {
            phase = 'failed';
            closePendingComputerUseChannel();
            const detail = formatRuntimeInitDiagnostic(error);
            // Classified here rather than in main: `detail` is a flattened string by
            // the time it crosses the pipe, and the fence hangs the owners-active
            // error off a wrapper's `cause` on the path users actually hit.
            const ownerConflict = findRuntimeOwnerConflict(error);
            log('runtime initialization failed');
            log(`runtime initialization detail: ${detail}`);
            if (ownerConflict) {
                log('runtime initialization blocked by an active Rootless V2 runtime owner ' +
                    `(holderPid=${ownerConflict.holderPid ?? 'unknown'}); reported to main as fail-fast`);
            }
            parentPort.postMessage({
                type: 'runtime-init-failed',
                message: 'utility runtime initialization failed',
                detail,
                // Conditional spread: the status validator rejects unknown/extra keys,
                // so an always-present `ownerConflict: undefined` would be dropped as
                // malformed and downgrade this into a slower bootstrap-timeout.
                ...(ownerConflict ? { ownerConflict } : {}),
            });
            // A half-initialized runtime must not linger (it may already hold the
            // SQLite handle); main also kills on init-failed — belt and braces.
            // The small delay lets the failure message flush through the pipe.
            setTimeout(() => exit(1), 50);
        }
    }
    function logShutdownReceived(appInstanceId) {
        try {
            log('[UtilityRuntime] runtime shutdown received', {
                ...(appInstanceId ? { app_instance_id: appInstanceId } : {}),
                phase,
                reason: 'runtime-shutdown',
            });
        }
        catch {
            // Diagnostics must never block runtime shutdown.
        }
    }
    async function handleShutdown() {
        if (phase === 'draining')
            return;
        phase = 'draining';
        stopHealthReporting();
        closePendingComputerUseChannel();
        closeConnections();
        const drain = (async () => {
            await authRotationTail;
            await surface?.shutdown();
        })();
        let drainTimer;
        const timedOut = await Promise.race([
            drain.then(() => false, () => {
                log('drain failed');
                return true;
            }),
            new Promise((resolve) => {
                drainTimer = setTimeout(() => resolve(true), drainGraceMs);
            }),
        ]);
        clearTimeout(drainTimer);
        if (timedOut) {
            log(`drain failed or exceeded ${drainGraceMs}ms grace; exiting`);
            exit(1);
            return;
        }
        parentPort.postMessage({ type: 'runtime-drained' });
        exit(0);
    }
    parentPort.on('message', (event) => {
        const message = event.data;
        if (!isUtilityControlMessage(message)) {
            if (options.handleMainMessage?.(message))
                return;
            log('ignored unrecognized control message');
            return;
        }
        switch (message.type) {
            case 'runtime-init':
                void handleInit(message, event.ports);
                return;
            case 'runtime-auth-context':
                if (phase === 'idle' || phase === 'starting') {
                    pendingAuthContext = message;
                    pendingAuthRequestIds.push(message.requestId);
                }
                else if (phase === 'ready') {
                    enqueueAuthContext(message);
                }
                return;
            case 'runtime-routing-context':
                if (phase === 'idle' || phase === 'starting') {
                    pendingRoutingContext = message.routingContext;
                    hasPendingRoutingContext = true;
                }
                else if (phase === 'ready' && surface) {
                    try {
                        surface.setRoutingContext(message.routingContext);
                    }
                    catch {
                        log('routing context update failed');
                    }
                }
                return;
            case 'runtime-context-window-usage':
                if (phase === 'ready' && surface) {
                    surface.setContextWindowUsageEnabled(message.enabled);
                }
                else if (phase === 'idle' || phase === 'starting') {
                    pendingContextWindowUsageEnabled = message.enabled;
                }
                return;
            case 'runtime-computer-use-connect':
                if (!event.ports[0]) {
                    log('runtime-computer-use-connect without a transferred port');
                    return;
                }
                if (phase === 'starting') {
                    closePendingComputerUseChannel();
                    pendingComputerUseChannel = {
                        port: event.ports[0],
                        generation: message.generation,
                    };
                }
                else if (phase === 'ready') {
                    attachComputerUseChannel(event.ports[0], message.generation);
                }
                else {
                    try {
                        event.ports[0].close();
                    }
                    catch {
                        // Nothing else owns the transferred port.
                    }
                }
                return;
            case 'runtime-runaway-guard-config':
                if (phase === 'ready' && surface) {
                    surface.setRunawayGuardConfig(message.config);
                }
                else if (phase === 'idle' || phase === 'starting') {
                    pendingRunawayGuardConfig = message.config;
                }
                return;
            case 'runtime-prompt-suggestion-policy':
                // Apply as soon as the surface exists: startup keeps `starting` while it
                // awaits the identity sync, and a policy buffered then would be lost.
                if (surface && (phase === 'starting' || phase === 'ready')) {
                    surface.setPromptSuggestionPolicy(message.policy);
                }
                else if (phase === 'idle' || phase === 'starting') {
                    pendingPromptSuggestionPolicy = message.policy;
                }
                return;
            case 'runtime-tool-result-compaction-config':
                if (phase === 'ready' && surface) {
                    surface.setToolResultCompactionConfig(message.config);
                }
                else if (phase === 'idle' || phase === 'starting') {
                    pendingToolResultCompactionConfig = message.config;
                }
                return;
            case 'runtime-collection-policy':
                if (phase === 'ready' && surface) {
                    surface.setCollectionPolicy(message.policy);
                }
                else if (phase === 'idle' || phase === 'starting') {
                    pendingCollectionPolicy = message.policy;
                }
                return;
            case 'runtime-port-connect': {
                const port = event.ports[0];
                if (!port) {
                    log(`runtime-port-connect without a transferred port (${message.connectionId})`);
                    return;
                }
                if (phase === 'draining' || phase === 'failed') {
                    try {
                        port.close();
                    }
                    catch {
                        // Nothing to release beyond the port itself.
                    }
                    return;
                }
                if (phase === 'ready') {
                    wirePort(message.connectionId, port);
                }
                else {
                    recentlyClosedConnections.delete(message.connectionId);
                    closeConnection(message.connectionId);
                    pendingPorts.set(message.connectionId, port);
                }
                return;
            }
            case 'runtime-port-disconnect': {
                const closed = closeConnection(message.connectionId);
                const result = closed.released
                    ? closed
                    : (consumeRemoteClose(message.connectionId) ?? closed);
                if (closed.released)
                    recentlyClosedConnections.delete(message.connectionId);
                parentPort.postMessage({
                    type: 'runtime-port-disconnected',
                    connectionId: message.connectionId,
                    ...result,
                });
                return;
            }
            case 'runtime-flush-logs': {
                const { requestId } = message;
                // Logger state is process-level (not surface-level), so the flush is
                // valid in every phase; the ACK must always go out so main's bounded
                // wait resolves promptly instead of burning its timeout.
                void (async () => {
                    try {
                        await options.flushLogs?.();
                    }
                    catch {
                        log('disk log flush failed');
                    }
                    try {
                        parentPort.postMessage({ type: 'runtime-logs-flushed', requestId });
                    }
                    catch {
                        // A torn-down parent port must not become an unhandled rejection
                        // that kills the utility process; main's bounded wait times out.
                        log('runtime-logs-flushed post failed');
                    }
                })();
                return;
            }
            case 'runtime-session-report-request': {
                const { requestId, sessionId } = message;
                void (async () => {
                    let response;
                    if (phase !== 'ready' || !surface) {
                        response = {
                            type: 'runtime-session-report-error',
                            requestId,
                            message: 'session_report_runtime_unavailable',
                        };
                    }
                    else {
                        try {
                            const report = await surface.collectSessionReport(sessionId);
                            response = { type: 'runtime-session-report-result', requestId, report };
                        }
                        catch (error) {
                            response = {
                                type: 'runtime-session-report-error',
                                requestId,
                                message: reportErrorMessage(error),
                            };
                        }
                    }
                    try {
                        parentPort.postMessage(response);
                    }
                    catch {
                        // Main has its own deadline; a torn-down port must not terminate Utility.
                        log('runtime-session-report response post failed');
                    }
                })();
                return;
            }
            case 'runtime-shutdown':
                logShutdownReceived(message.app_instance_id);
                void handleShutdown();
                return;
        }
    });
    return {
        connectionCount: () => connections.size,
    };
}
function reportErrorMessage(error) {
    const message = error instanceof Error ? error.message : String(error);
    return (message.trim() || 'session_report_failed').slice(0, 2048);
}
