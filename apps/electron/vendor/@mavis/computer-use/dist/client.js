import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { discoverComponent, } from './component.js';
import { createCuaDriverRuntime, CuaLocalAbortError, } from './cua-driver-runtime.js';
import { createCuaStructuredLogger } from './cua-logging.js';
import { callCuaToolWithDeliveryMode, mapRequestToCuaTool, normalizeCuaResult } from './mapping.js';
import { observeLaunchedWindows } from './cua-launch-observation.js';
import { startOwnedDaemon, requestComponentPermissions } from './daemon.js';
import { acquireDesktopLock, desktopLockRoot } from './desktop-lock.js';
import { ComputerUseError, record, structured, } from './contracts.js';
/** Call only after Runtime checks plugin, Skill, explicit selection and tool policy. */
export function createComputerUseClient(options) {
    if (!path.isAbsolute(options.dataDir) || !options.ownerId.trim()) {
        throw new ComputerUseError('computer_owner_required', 'An absolute profile dataDir and nonempty ownerId are required.');
    }
    const logger = options.logger ?? createCuaStructuredLogger();
    const resolveComponent = options.resolveComponent ?? (() => discoverComponent(options));
    let component;
    let daemon;
    let runtime;
    let starting;
    let closing;
    let closed = false;
    let poisoned = false;
    let lease;
    let operation;
    let cleaning;
    let generation = 0;
    let admissionRevision = 0;
    const endedTurns = new Set();
    // No eviction: dropping an accepted ID would turn a later replay into a new input.
    const acceptedRequestIds = new Set();
    const observedSessions = new Set();
    function open() {
        if (closed)
            throw new ComputerUseError('computer_closed', 'This Computer Use client is closed.');
    }
    async function retireRuntime() {
        // Never detach an uncertain connection or release its lock before owned-daemon exit.
        // Keep all references on failure so a later drain can retry the same owner only.
        if (!daemon)
            throw new ComputerUseError('computer_stop_unconfirmed', 'No owned daemon can prove drain.', 'unknown');
        const retiredDaemon = daemon;
        const retiredRuntime = runtime;
        await retiredDaemon.stop();
        await retiredRuntime?.shutdown().catch(() => undefined);
        runtime = undefined;
        daemon = undefined;
        poisoned = false;
        observedSessions.clear();
    }
    async function prepareRuntime() {
        open();
        if (!starting) {
            starting = (async () => {
                if (runtime && !poisoned) {
                    try {
                        await daemon.check();
                        return;
                    }
                    catch {
                        poisoned = true;
                    }
                }
                if (daemon)
                    await retireRuntime();
                open();
                component = await resolveComponent();
                open();
                daemon = await startOwnedDaemon(component, options.dataDir, options.ownerId);
                try {
                    open();
                    runtime = await createCuaDriverRuntime({
                        generation: ++generation,
                        endpoint: daemon.endpoint,
                        pid: daemon.pid,
                        sdkRuntimeDirectory: options.sdkRuntimeDirectory,
                    });
                    open();
                }
                catch (error) {
                    poisoned = true;
                    await retireRuntime();
                    throw error;
                }
            })().finally(() => {
                starting = undefined;
            });
        }
        await starting;
    }
    async function ensureReady() {
        open();
        // Public readiness must not replace a connection while native work is draining.
        while (operation || cleaning) {
            await operation?.catch(() => undefined);
            await cleaning;
            open();
        }
        if (lease?.released)
            await cleanupLease(lease);
        await prepareRuntime();
    }
    async function permissions() {
        if (process.platform === 'win32')
            return permissionStatus({}, false);
        if (!runtime)
            return {
                supported: ['darwin', 'win32'].includes(process.platform),
                ready: false,
                accessibility: false,
                screenRecording: false,
                granted: false,
            };
        const checkedRuntime = runtime;
        try {
            const value = await checkedRuntime.callTool('check_permissions', {
                session: 'permission-status',
            });
            if (runtime !== checkedRuntime)
                throw new ComputerUseError('computer_generation_mismatch', 'Permission status belongs to a retired connection.');
            return permissionStatus(structured(value) ?? {}, false);
        }
        catch (error) {
            if (runtime === checkedRuntime)
                poisoned = true;
            throw error;
        }
    }
    function permissionStatus(status, probed) {
        if (process.platform === 'win32')
            return {
                supported: true,
                ready: !!runtime,
                componentVersion: component?.manifest.version,
                accessibility: true,
                screenRecording: true,
                granted: true,
                captureReadiness: 'not_required',
            };
        const source = record(status.source);
        // host_bundle_id is only a label. The driver must report its real App attribution.
        const attributed = source?.attribution === 'driver-daemon' && source.bundle_id === component?.manifest.bundleId;
        const accessibility = attributed && status.accessibility === true;
        const screenRecording = attributed && status.screen_recording === true;
        const directCaptureStatus = typeof status.direct_capture_status === 'string'
            ? status.direct_capture_status
            : 'not_checked';
        const capturable = typeof status.screen_recording_capturable === 'boolean'
            ? status.screen_recording_capturable
            : null;
        const evidence = record(status.direct_capture_verification);
        const verifiedAt = typeof evidence?.verified_at === 'string' ? Date.parse(evidence.verified_at) : NaN;
        const verification = attributed &&
            evidence?.source === 'permissions_grant' &&
            evidence.bundle_id === component?.manifest.bundleId &&
            Number.isFinite(verifiedAt) &&
            verifiedAt > 0
            ? { source: 'permissions_grant', verifiedAt, bundleId: evidence.bundle_id }
            : undefined;
        // A negative/incomplete probe always overrides historical evidence, including persistence errors.
        const failed = capturable === false ||
            !['not_checked', 'ready'].includes(directCaptureStatus) ||
            status.direct_capture_error != null ||
            status.direct_capture_verification_error != null;
        const live = probed && capturable === true && directCaptureStatus === 'ready';
        const previouslyVerified = !probed && capturable === null && directCaptureStatus === 'not_checked' && !!verification;
        const captureReady = attributed && !failed && (live || previouslyVerified);
        const granted = accessibility && screenRecording && captureReady;
        return {
            supported: true,
            ready: !!runtime,
            componentVersion: component?.manifest.version,
            accessibility,
            screenRecording,
            granted,
            screenRecordingCapturable: capturable,
            directCaptureStatus,
            directCaptureError: record(status.direct_capture_error),
            directCaptureVerificationError: record(status.direct_capture_verification_error),
            directCaptureVerification: verification,
            permissionSource: source,
            captureReadiness: !attributed || failed
                ? 'unavailable'
                : live
                    ? 'live'
                    : previouslyVerified
                        ? 'previously_verified'
                        : 'unverified',
            ...(!granted
                ? {
                    code: accessibility && screenRecording
                        ? 'computer_capture_verification_required'
                        : 'computer_permission_required',
                    message: 'Use the trusted MiniMax Computer Use setup entry to grant system permissions and verify direct capture.',
                }
                : {}),
        };
    }
    async function getStatus() {
        try {
            open();
            await ensureReady();
            return await permissions();
        }
        catch (error) {
            return {
                supported: ['darwin', 'win32'].includes(process.platform),
                ready: false,
                accessibility: false,
                screenRecording: false,
                granted: false,
                code: error instanceof ComputerUseError ? error.code : 'computer_component_unavailable',
                message: error instanceof ComputerUseError
                    ? error.message
                    : 'Computer Use component is unavailable.',
            };
        }
    }
    function release(sessionId, turnId) {
        admissionRevision++;
        if (sessionId && turnId)
            endedTurns.add(JSON.stringify([sessionId, turnId]));
        const active = lease;
        if (active &&
            (!sessionId || active.sessionId === sessionId) &&
            (!turnId || active.turnId === turnId)) {
            if (active.turnId)
                endedTurns.add(JSON.stringify([active.sessionId, active.turnId]));
            active.released = true;
            active.controller.abort();
            if (!operation)
                void cleanupLease(active).catch(() => {
                    poisoned = true;
                });
        }
        notify(() => options.onRelease?.(sessionId, turnId));
    }
    async function cleanupLease(active) {
        if (cleaning)
            return cleaning;
        cleaning = (async () => {
            // Reserve cleanup before waiting; readiness must finish replacing the connection first.
            await starting?.catch(() => undefined);
            if (!active.lock) {
                if (lease === active)
                    lease = undefined;
                return;
            }
            if (poisoned) {
                // A transport error can precede completion. Only confirmed owned-daemon exit releases the desktop.
                await retireRuntime();
            }
            else if (runtime) {
                try {
                    const ended = await runtime.callTool('end_session', { session: active.sessionId });
                    if (record(ended)?.isError)
                        throw new Error('end_session refused');
                }
                catch {
                    poisoned = true;
                    await retireRuntime();
                }
            }
            await active.lock.release();
            if (lease === active)
                lease = undefined;
            notify(() => options.onRelease?.(active.sessionId, active.turnId));
        })().finally(() => {
            cleaning = undefined;
        });
        return cleaning;
    }
    async function call(request, signal) {
        open();
        if (!request.sessionId.trim() ||
            endedTurns.has(JSON.stringify([request.sessionId, request.turnId]))) {
            throw new ComputerUseError('computer_aborted', 'This control session/turn has been released.');
        }
        signal?.throwIfAborted();
        if (!operation && !cleaning && lease?.released) {
            // A previous stop may have failed. Retry only cleanup, then recheck admission
            // before accepting this new request; never replay the uncertain operation.
            const cleanupRevision = admissionRevision;
            const cleanup = cleanupLease(lease);
            await (signal ? abortableWait(cleanup, signal, () => false) : cleanup);
            if (cleanupRevision !== admissionRevision)
                throw new ComputerUseError('computer_aborted', 'Request admission was revoked.');
            return call(request, signal);
        }
        if (operation ||
            cleaning ||
            lease?.released ||
            (lease && (lease.sessionId !== request.sessionId || lease.leaseId !== request.leaseId))) {
            throw new ComputerUseError('computer_busy', 'Another request/control session owns the desktop.');
        }
        const requestId = request.requestId?.trim() ? request.requestId : randomUUID();
        if (acceptedRequestIds.has(requestId))
            throw new ComputerUseError('computer_request_replayed', 'Request was already admitted; observe again instead of replaying input.', 'unknown');
        acceptedRequestIds.add(requestId);
        const active = (lease ??= {
            sessionId: request.sessionId,
            turnId: request.turnId,
            leaseId: request.leaseId,
            controller: new AbortController(),
            released: false,
        });
        active.turnId = request.turnId;
        const revision = admissionRevision;
        const requestSignal = signal
            ? AbortSignal.any([signal, active.controller.signal])
            : active.controller.signal;
        let envelope = { ...request, version: 1, requestId, generation };
        let dispatched = false;
        let cleanupAttempted = false;
        const abort = () => release(request.sessionId, request.turnId);
        requestSignal.addEventListener('abort', abort, { once: true });
        const work = (async () => {
            try {
                active.lock ??= await acquireDesktopLock(desktopLockRoot(), options.ownerId);
                requestSignal.throwIfAborted();
                await prepareRuntime();
                envelope = { ...envelope, generation };
                requestSignal.throwIfAborted();
                if (revision !== admissionRevision)
                    throw new ComputerUseError('computer_aborted', 'Request admission was revoked.');
                const status = await permissions();
                if (!status.granted)
                    throw new ComputerUseError(status.code ?? 'computer_permission_required', status.message ??
                        'Grant system permissions to the standalone MiniMax Computer Use App.');
                if (generation > 1 &&
                    !isObservation(request.kind) &&
                    !observedSessions.has(request.sessionId))
                    throw new ComputerUseError('computer_observation_required', 'The Computer Use connection was restored. Inspect the desktop or exact window again before sending input; prior actions were not replayed.');
                requestSignal.throwIfAborted();
                // Wrapper marks *every* dispatch, including target inventory and launch observation.
                // A rejected SDK wait gives no native completion proof and poisons this connection.
                const operationRuntime = runtime;
                const checkedRuntime = {
                    generation: operationRuntime.generation,
                    driverVersion: operationRuntime.driverVersion,
                    shutdown: () => operationRuntime.shutdown(),
                    async callTool(name, args, currentSignal) {
                        currentSignal?.throwIfAborted();
                        if (runtime !== operationRuntime)
                            throw new ComputerUseError('computer_generation_mismatch', 'Observe again using the current Computer Use connection.');
                        dispatched = true;
                        try {
                            return await operationRuntime.callTool(name, args, currentSignal, envelope.sessionTitle);
                        }
                        catch (error) {
                            // Only locally proven cancellation is safe; SDK rejection still has unknown drain.
                            if (runtime === operationRuntime && !(error instanceof CuaLocalAbortError))
                                poisoned = true;
                            throw error;
                        }
                    },
                };
                const mapped = request.kind === 'display_list'
                    ? undefined
                    : await mapRequestToCuaTool(checkedRuntime, envelope, requestSignal);
                const presentation = {
                    runtime: checkedRuntime,
                    request: envelope,
                    payload: mapped?.payload ?? {},
                    signal: requestSignal,
                };
                if (options.onMapped) {
                    try {
                        await options.onMapped(presentation);
                    }
                    catch {
                        /* Optional presentation. */
                    }
                }
                requestSignal.throwIfAborted();
                if (poisoned)
                    throw new ComputerUseError('computer_driver_error', 'Presentation observed a broken driver connection.', 'unknown');
                const foreground = isForegroundOperation(request.kind, presentation.payload);
                notify(() => options.onActivityChange?.(1));
                if (foreground)
                    notify(() => options.onOperation?.(envelope));
                let result;
                try {
                    if (mapped)
                        result = await callCuaToolWithDeliveryMode(checkedRuntime, mapped.name, mapped.payload, requestSignal);
                    else {
                        if (!options.readDisplays)
                            throw new ComputerUseError('computer_display_observation_unavailable', 'Full display inventory requires a trusted host display reader.');
                        result = await options.readDisplays(requestSignal);
                    }
                }
                finally {
                    if (foreground)
                        notify(() => options.onOperationFinished?.(envelope));
                }
                requestSignal.throwIfAborted();
                if (options.onResult) {
                    try {
                        await options.onResult({ ...presentation, result });
                    }
                    catch {
                        /* Optional presentation. */
                    }
                }
                requestSignal.throwIfAborted();
                if (poisoned)
                    throw new ComputerUseError('computer_driver_error', 'Presentation observed a broken driver connection.', 'unknown');
                if (request.kind === 'app_launch')
                    result = await observeLaunchedWindows({
                        runtime: checkedRuntime,
                        request: envelope,
                        result,
                        signal: requestSignal,
                        logger,
                    });
                if (['app_state', 'desktop_state'].includes(request.kind) && !record(result)?.isError) {
                    observedSessions.add(request.sessionId);
                }
                return normalizeCuaResult(envelope, result);
            }
            catch (error) {
                // Failed setup/permissions must not leave an unusable lease blocking trusted setup.
                active.released = true;
                if (error instanceof ComputerUseError)
                    throw error;
                const message = error instanceof Error ? error.message : 'Computer Use failed.';
                throw new ComputerUseError(requestSignal.aborted
                    ? 'computer_aborted'
                    : (/^computer_[a-z0-9_]+/.exec(message)?.[0] ?? 'computer_driver_error'), message, dispatched ? 'unknown' : 'not_started');
            }
            finally {
                requestSignal.removeEventListener('abort', abort);
                notify(() => options.onActivityChange?.(0));
                if (active.released) {
                    cleanupAttempted = true;
                    await cleanupLease(active);
                }
            }
        })();
        operation = work;
        void work
            .finally(async () => {
            if (operation === work)
                operation = undefined;
            // A release can arrive after work's own finally but before this drain continuation.
            if (!cleanupAttempted && active.released && lease === active)
                await cleanupLease(active);
        })
            .catch(() => undefined);
        return abortableWait(work, requestSignal, () => dispatched);
    }
    return {
        ensureReady,
        call,
        release,
        getStatus,
        async requestPermissions() {
            open();
            if (operation || lease || cleaning)
                throw new ComputerUseError('computer_busy', 'Finish computer control before changing system permissions.');
            component ??= await resolveComponent();
            const result = await requestComponentPermissions(component);
            // Permissions are checked again in the daemon immediately before every product request.
            return permissionStatus(result, true);
        },
        close() {
            if (closing)
                return closing;
            closed = true;
            release();
            closing = (async () => {
                await starting?.catch(() => undefined);
                await operation?.catch(() => undefined);
                await cleaning;
                if (lease) {
                    lease.released = true;
                    await cleanupLease(lease);
                }
                try {
                    await runtime?.shutdown();
                }
                finally {
                    await daemon?.stop();
                }
            })();
            return closing;
        },
    };
}
function isObservation(kind) {
    return [
        'app_list',
        'window_list',
        'display_list',
        'desktop_state',
        'app_state',
        'verify_state',
    ].includes(kind);
}
function isForegroundOperation(kind, payload) {
    if (isObservation(kind))
        return false;
    return (['app_activate', 'app_launch', 'secondary_action'].includes(kind) ||
        payload.delivery_mode === 'foreground' ||
        record(payload.target)?.kind === 'desktop');
}
function notify(callback) {
    try {
        callback();
    }
    catch {
        /* Presentation cannot affect control ownership. */
    }
}
function abortableWait(work, signal, dispatched) {
    return new Promise((resolve, reject) => {
        const abort = () => reject(new ComputerUseError('computer_aborted', 'Request wait cancelled; native work is draining and will not be replayed.', dispatched() ? 'unknown' : 'not_started'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted)
            abort();
        void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}
//# sourceMappingURL=client.js.map